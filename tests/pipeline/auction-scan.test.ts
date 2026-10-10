import { describe, expect, it } from 'vitest';
import { addEntry } from '../../src/bankroll/bankroll-repo.js';
import { upsertListing } from '../../src/listings/listings-repo.js';
import { silentLog } from '../../src/log.js';
import { auctionScan, type AuctionScanDeps } from '../../src/pipeline/auction-scan.js';
import { setSetting } from '../../src/settings/settings.js';
import type { Budget } from '../../src/sources/ebay/budget.js';
import type { EbayItemSummary } from '../../src/sources/ebay/ebay-client.js';
import { summaryToListing } from '../../src/sources/ebay/normalize.js';
import { createTestDb } from '../helpers/test-db.js';
import { ITEM, SUMMARY, seedCards } from '../helpers/fixtures.js';

const NOW = new Date('2026-10-03T12:00:00Z');
const inMin = (m: number) => new Date(NOW.getTime() + m * 60_000).toISOString();

function auction(id: string, bid: number, endsInMin: number): EbayItemSummary {
  const rest: Partial<EbayItemSummary> = { ...SUMMARY };
  delete rest.price;
  delete rest.shippingOptions;
  return {
    ...(rest as EbayItemSummary), itemId: id, buyingOptions: ['AUCTION'], currentBidPrice: { value: bid.toFixed(2), currency: 'USD' },
    bidCount: 3, itemEndDate: inMin(endsInMin),
  };
}

async function setup(opts: { used?: number; results?: EbayItemSummary[] } = {}) {
  const db = await createTestDb();
  await seedCards(db);
  await addEntry(db, { kind: 'deposit', amount: 2000 });
  const calls = { search: 0, getItem: 0, windows: [] as number[] };
  const budget: Budget = { limit: 5000, beforeCall: async () => {}, usedToday: async () => opts.used ?? 0 };
  const deps: AuctionScanDeps = {
    db,
    budget,
    ebay: {
      searchEndingAuctions: async (w) => { calls.search++; calls.windows.push(w); return opts.results ?? [auction('v1|A1|0', 200, 30)]; },
      getItem: async (id) => {
        calls.getItem++;
        return { ...ITEM, ...auction(id, 200, 30), shippingOptions: [{ shippingCost: { value: '20.00', currency: 'USD' } }] };
      },
    },
    valuate: async (key) => ({
      ...key, value: 600, low: 590, high: 610, compCount: 6, newestCompAgeDays: 1, confidence: 0.9,
      compsSource: 'fixture', oracleVersion: 'v1.0.0', computedAt: NOW,
    }),
    now: () => NOW,
    log: silentLog,
  };
  return { db, deps, calls };
}

describe('auctionScan', () => {
  it('is paused / disabled / throttled before any search', async () => {
    const a = await setup();
    await setSetting(a.db, 'paused', true);
    expect((await auctionScan(a.deps)).status).toBe('paused');
    const b = await setup();
    await setSetting(b.db, 'auctionMode', false);
    expect((await auctionScan(b.deps)).status).toBe('disabled');
    const c = await setup({ used: 4000 });
    expect((await auctionScan(c.deps)).status).toBe('throttled');
    expect(a.calls.search + b.calls.search + c.calls.search).toBe(0);
  });

  it('recommends an auction once and never re-evaluates it', async () => {
    const { db, deps, calls } = await setup();
    const first = await auctionScan(deps);
    expect(first).toMatchObject({ status: 'ok', seen: 1, new: 1, errors: 0 });
    expect(first.outcomes).toEqual({ recommended: 1 });
    expect(calls.windows).toEqual([60]);
    const second = await auctionScan(deps);
    expect(second.outcomes).toEqual({});
    expect(calls.getItem).toBe(1);
    const { rows } = await db.query<{ kind: string; origin: string }>(
      `select r.kind, l.origin from recommendations r join listings l on l.external_id = r.external_id`,
    );
    expect(rows).toEqual([{ kind: 'auction', origin: 'auction' }]);
  });

  it('skips auctions ending within 3 minutes or already ended', async () => {
    const { db, deps } = await setup({ results: [auction('v1|A2|0', 200, 2), auction('v1|A3|0', 200, -5)] });
    const r = await auctionScan(deps);
    expect(r).toMatchObject({ seen: 2, new: 0 });
    const { rows } = await db.query('select 1 from listings');
    expect(rows).toHaveLength(0);
  });

  it('skips an item stored with another origin', async () => {
    const { db, deps, calls } = await setup();
    await upsertListing(db, summaryToListing({ ...SUMMARY, itemId: 'v1|A1|0' })!, NOW);
    const r = await auctionScan(deps);
    expect(r.outcomes).toEqual({});
    expect(calls.getItem).toBe(0);
    const { rows } = await db.query<{ origin: string }>(`select origin from listings where external_id = 'v1|A1|0'`);
    expect(rows).toEqual([{ origin: 'us_bin' }]);
  });

  it('records no window misses for auctions', async () => {
    const { db, deps } = await setup();
    await auctionScan(deps);
    deps.ebay = { ...deps.ebay, searchEndingAuctions: async () => [] };
    const r = await auctionScan(deps);
    expect(r.missed).toBe(0);
    const { rows } = await db.query<{ miss_count: number }>('select miss_count from listings');
    expect(rows[0]!.miss_count).toBe(0);
  });
});
