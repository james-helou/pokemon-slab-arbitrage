import { describe, expect, it } from 'vitest';
import { addEntry } from '../../src/bankroll/bankroll-repo.js';
import { loadChannels } from '../../src/channels/channels.js';
import type { Valuation } from '../../src/domain/types.js';
import { getRecommendation } from '../../src/ledger/ledger-repo.js';
import { upsertListing } from '../../src/listings/listings-repo.js';
import { silentLog } from '../../src/log.js';
import { evaluateListing } from '../../src/pipeline/evaluate.js';
import { DEFAULT_SETTINGS, type Settings } from '../../src/settings/settings.js';
import type { EbayItem, EbayItemSummary } from '../../src/sources/ebay/ebay-client.js';
import { summaryToListing } from '../../src/sources/ebay/normalize.js';
import { createTestDb } from '../helpers/test-db.js';
import { ITEM, SUMMARY, seedCards } from '../helpers/fixtures.js';

const NOW = new Date('2026-10-03T12:00:00Z');
const ENDS = '2026-10-03T12:40:00.000Z';
const VALUATION: Valuation = {
  cardId: 'sv03.5-199', grader: 'PSA', grade: 10, value: 600, low: 592.5, high: 607.5, compCount: 6,
  newestCompAgeDays: 1, confidence: 0.9, compsSource: 'ppt', oracleVersion: 'v1.0.0', computedAt: NOW,
};
const SHIP20 = [{ shippingCost: { value: '20.00', currency: 'USD' } }];

function auctionSummary(bid: number): EbayItemSummary {
  const rest: Partial<EbayItemSummary> = { ...SUMMARY };
  delete rest.price;
  delete rest.shippingOptions;
  return {
    ...(rest as EbayItemSummary), buyingOptions: ['AUCTION'], currentBidPrice: { value: bid.toFixed(2), currency: 'USD' }, bidCount: 5, itemEndDate: ENDS,
  };
}

async function run(
  o: { bid: number; itemBid?: number; source?: string; settings?: Partial<Settings>; raw?: number; cash?: number },
) {
  const db = await createTestDb();
  await seedCards(db);
  await addEntry(db, { kind: 'deposit', amount: o.cash ?? 2000 });
  const spends: (boolean | undefined)[] = [];
  let getItemCalls = 0;
  const summary = auctionSummary(o.bid);
  const item: EbayItem = {
    ...ITEM, ...summary, shippingOptions: SHIP20,
    currentBidPrice: { value: (o.itemBid ?? o.bid).toFixed(2), currency: 'USD' }, bidCount: 6,
  };
  const deps = {
    db,
    ebay: { getItem: async () => { getItemCalls++; return item; } },
    valuate: async (_k: unknown, _s: unknown, opts?: { spend?: boolean }) => { spends.push(opts?.spend); return o.source ? { ...VALUATION, compsSource: o.source } : VALUATION; },
    now: () => NOW,
    log: silentLog,
    ...(o.raw === undefined ? {} : { rawPrice: async () => o.raw! }),
  };
  const listing = summaryToListing(summary, { origin: 'auction' })!;
  await upsertListing(db, listing, NOW);
  const outcome = await evaluateListing(deps, listing, { ...DEFAULT_SETTINGS, ...o.settings }, await loadChannels(db));
  return { db, outcome, spends, getItemCalls: () => getItemCalls };
}

describe('evaluateListing auctions', () => {
  it('recommends an auction with the max bid as the suggested price', async () => {
    const r = await run({ bid: 200 });
    expect(r.outcome.status).toBe('recommended');
    const rec = (await getRecommendation(r.db, r.outcome.recommendationId!))!;
    expect(rec).toMatchObject({ kind: 'auction', suggestedPrice: 352.26, routedTo: 'alerts' });
    expect(rec.buyTotal).toBeCloseTo(428.01, 2);
    expect(rec.listingSnapshot.auction).toEqual({ currentBid: 200, bidCount: 6, endsAt: ENDS });
  });

  it('rejects a current bid above auctionAlertPct x max bid', async () => {
    const r = await run({ bid: 300 });
    expect(r.outcome).toMatchObject({ status: 'rejected', reasons: ['auction_bid_too_high'] });
  });

  it('rejects before getItem when even free shipping cannot make the bid work', async () => {
    // Optimistic max (shipping 0) = 372.26; 0.7 x 372.26 = 260.58 < 300.
    const r = await run({ bid: 300 });
    expect(r.getItemCalls()).toBe(0);
  });

  it('uses the fresher bid from getItem', async () => {
    // 250 > 0.7 x 352.26 = 246.58, but 250 <= 260.58 so the optimistic filter lets it reach getItem.
    const r = await run({ bid: 200, itemBid: 250 });
    expect(r.getItemCalls()).toBe(1);
    expect(r.outcome).toMatchObject({ status: 'rejected', reasons: ['auction_bid_too_high'] });
  });

  it('routes over_budget when the max-bid buy total exceeds cash', async () => {
    const r = await run({ bid: 200, cash: 400 });
    const rec = (await getRecommendation(r.db, r.outcome.recommendationId!))!;
    expect(rec).toMatchObject({ kind: 'auction', routedTo: 'over_budget' });
  });

  it('does not spend credits on an auction by default, even when promising', async () => {
    const r = await run({ bid: 200 });
    expect(r.spends).toEqual([false]);
    expect(r.outcome.status).toBe('recommended');
  });

  it('spends on a promising auction when auctionSpendsCredits is on', async () => {
    const r = await run({ bid: 200, settings: { auctionSpendsCredits: true } });
    expect(r.spends).toEqual([true]);
  });

  it('rejects an auction valued from own comps with auction_no_credit', async () => {
    const r = await run({ bid: 200, source: 'own_db' });
    expect(r.outcome).toMatchObject({ status: 'no_valuation', reasons: ['auction_no_credit'] });
    expect(r.getItemCalls()).toBe(0);
  });

  it('keeps not_promising when the auction is also unpromising', async () => {
    const r = await run({ bid: 450, raw: 600, source: 'own_db', settings: { rawPromiseMultipliers: { default: 1 }, rawCeilingMultipliers: { default: 100 } } });
    expect(r.outcome).toMatchObject({ status: 'no_valuation', reasons: ['not_promising'] });
  });

  it('decides spend from the current bid', async () => {
    const settings = { auctionSpendsCredits: true, rawPromiseMultipliers: { default: 1 }, rawCeilingMultipliers: { default: 100 } };
    const cheap = await run({ bid: 200, raw: 600, settings });
    expect(cheap.spends).toEqual([true]);
    const dear = await run({ bid: 450, raw: 600, settings });
    expect(dear.spends).toEqual([false]);
  });
});
