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
const VALUATION: Valuation = {
  cardId: 'sv03.5-199', grader: 'PSA', grade: 10, value: 600, low: 592.5, high: 607.5, compCount: 6,
  newestCompAgeDays: 1, confidence: 0.9, compsSource: 'fixture', oracleVersion: 'v1.0.0', computedAt: NOW,
};
const BO = ['FIXED_PRICE', 'BEST_OFFER'];
const SHIP20 = [{ shippingCost: { value: '20.00', currency: 'USD' } }];

async function run(
  o: { ask: number; options?: string[]; settings?: Partial<Settings>; raw?: number; itemOptions?: string[]; summaryShip?: string },
) {
  const db = await createTestDb();
  await seedCards(db);
  await addEntry(db, { kind: 'deposit', amount: 2000 });
  const spends: (boolean | undefined)[] = [];
  let getItemCalls = 0;
  const summary: EbayItemSummary = {
    ...SUMMARY, price: { value: o.ask.toFixed(2), currency: 'USD' }, shippingOptions: o.summaryShip ? [{ shippingCost: { value: o.summaryShip, currency: 'USD' } }] : SHIP20,
    buyingOptions: o.options ?? ['FIXED_PRICE'],
  };
  const item: EbayItem = { ...ITEM, ...summary, shippingOptions: SHIP20, buyingOptions: o.itemOptions ?? o.options ?? ['FIXED_PRICE'] };
  const deps = {
    db,
    ebay: { getItem: async () => { getItemCalls++; return item; } },
    valuate: async (_k: unknown, _s: unknown, opts?: { spend?: boolean }) => { spends.push(opts?.spend); return VALUATION; },
    now: () => NOW,
    log: silentLog,
    ...(o.raw === undefined ? {} : { rawPrice: async () => o.raw! }),
  };
  const listing = summaryToListing(summary)!;
  await upsertListing(db, listing, NOW);
  const outcome = await evaluateListing(deps, listing, { ...DEFAULT_SETTINGS, ...o.settings }, await loadChannels(db));
  return { db, outcome, spends, getItemCalls: () => getItemCalls };
}

describe('evaluateListing Best Offer', () => {
  it('recommends an offer when the ask fails but a lower price clears the rules', async () => {
    const r = await run({ ask: 450, options: BO });
    expect(r.outcome.status).toBe('recommended');
    const rec = (await getRecommendation(r.db, r.outcome.recommendationId!))!;
    expect(rec).toMatchObject({ kind: 'offer', suggestedPrice: 350, routedTo: 'alerts' });
    expect(rec.buyTotal).toBeCloseTo(425.41, 2);
    expect(rec.bestNet).toBeCloseTo(88.19, 2);
    expect(rec.listingSnapshot.price).toBe(450);
    expect(rec.listingSnapshot.buyingOptions).toEqual(BO);
  });

  it('keeps a normal bin alert when the ask already works', async () => {
    const r = await run({ ask: 352, options: BO });
    const rec = (await getRecommendation(r.db, r.outcome.recommendationId!))!;
    expect(rec.kind).toBe('bin');
    expect(rec.suggestedPrice ?? null).toBeNull();
  });

  it('rejects offer_too_deep and stores nothing', async () => {
    // The summary shows free shipping, so the pre-score passes at 360; getItem reveals 20, capping the max price at 352.26 < 360.
    const r = await run({ ask: 480, options: BO, summaryShip: '0.00' });
    expect(r.getItemCalls()).toBe(1);
    expect(r.outcome.status).toBe('rejected');
    expect(r.outcome.reasons).toContain('offer_too_deep');
    const { rows } = await r.db.query('select 1 from recommendations');
    expect(rows).toHaveLength(0);
  });

  it('rejects at the stage-1 pre-score when even the minimum offer cannot clear the rules', async () => {
    const r = await run({ ask: 480, options: BO });
    expect(r.outcome.status).toBe('rejected');
    expect(r.getItemCalls()).toBe(0);
  });

  it('rejects the same ask without BEST_OFFER', async () => {
    expect((await run({ ask: 450 })).outcome.status).toBe('rejected');
  });

  it('rejects when offerMode is off', async () => {
    expect((await run({ ask: 450, options: BO, settings: { offerMode: false } })).outcome.status).toBe('rejected');
  });

  it('falls back to bin when getItem no longer shows BEST_OFFER', async () => {
    const r = await run({ ask: 450, options: BO, itemOptions: ['FIXED_PRICE'] });
    expect(r.outcome.status).toBe('rejected');
  });

  it('triages and pre-scores at offerMinPctOfAsk x ask', async () => {
    // cost(450) = 470 * 1.14975 = 540.4; cost(337.5) = 357.5 * 1.14975 = 411.0. Limit = 0.8 * raw * promiseMult.
    const settings = { rawPromiseMultipliers: { default: 1 }, rawCeilingMultipliers: { default: 100 } };
    const raw = 600; // limit 480: 411 <= 480 < 540
    const bo = await run({ ask: 450, options: BO, raw, settings });
    expect(bo.spends).toEqual([true]);
    expect(bo.getItemCalls()).toBe(1);
    const plain = await run({ ask: 450, raw, settings });
    expect(plain.spends).toEqual([false]);
  });
});
