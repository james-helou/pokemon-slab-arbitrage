import { describe, expect, it } from 'vitest';
import { sweepDisappeared, type SweepDeps } from '../../src/disappearing/sweep.js';
import { insertMatch, upsertListing } from '../../src/listings/listings-repo.js';
import { silentLog } from '../../src/log.js';
import type { MatchResult } from '../../src/matcher/matcher.js';
import { setSetting, type Settings } from '../../src/settings/settings.js';
import type { EbayItem } from '../../src/sources/ebay/ebay-client.js';
import { summaryToListing } from '../../src/sources/ebay/normalize.js';
import { createTestDb } from '../helpers/test-db.js';
import { ITEM, SUMMARY, seedCards } from '../helpers/fixtures.js';

const NOW = new Date('2026-10-03T12:00:00Z');
const SOLD_OUT: EbayItem = { ...ITEM, estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'OUT_OF_STOCK' }] };
const match = (confidence: number): MatchResult => ({
  match: { cardId: 'sv03.5-199', grader: 'PSA', grade: 10, gradeLabel: null, cert: null, confidence, reasons: [], matcherVersion: 'v1.0.0' },
  reasons: [],
});

async function setup(o: {
  getItem?: () => Promise<EbayItem | null>; confidence?: number; price?: string; lastSeen?: Date;
  settings?: Partial<Settings>; mainUsed?: number;
} = {}) {
  const db = await createTestDb();
  await seedCards(db);
  const l = summaryToListing({ ...SUMMARY, price: { value: o.price ?? '350.00', currency: 'USD' } })!;
  await upsertListing(db, l, o.lastSeen ?? NOW);
  await insertMatch(db, l, match(o.confidence ?? 0.9), 'title');
  await db.query('update listings set miss_count = 3');
  for (const [k, v] of Object.entries(o.settings ?? {})) await setSetting(db, k as keyof Settings, v as never);
  let calls = 0;
  const deps: SweepDeps = {
    db,
    ebay: { getItem: async () => { calls++; return o.getItem ? o.getItem() : null; } },
    budget: { limit: 5000, beforeCall: async () => {}, usedToday: async () => o.mainUsed ?? 0 },
    now: () => NOW,
    log: silentLog,
  };
  const listing = async () =>
    (await db.query<{ gone_at: Date | null; gone_reason: string | null; miss_count: number }>(
      'select gone_at, gone_reason, miss_count from listings',
    )).rows[0]!;
  const comps = async () =>
    (await db.query<{ n: number }>(`select count(*)::int as n from comps where kind = 'disappearing_bin'`)).rows[0]!.n;
  return { db, deps, calls: () => calls, listing, comps };
}

describe('sweepDisappeared', () => {
  it('confirms a 404 as not_found, writes the comp, and does not re-check', async () => {
    const { deps, calls, listing, comps } = await setup();
    expect(await sweepDisappeared(deps)).toMatchObject({ status: 'ok', suspects: 1, notFound: 1, compsWritten: 1 });
    expect((await listing()).gone_reason).toBe('not_found');
    expect(await comps()).toBe(1);
    expect(await sweepDisappeared(deps)).toMatchObject({ suspects: 0, compsWritten: 0 });
    expect(calls()).toBe(1);
  });

  it('ignores non-USD listings', async () => {
    const { db, deps, calls } = await setup();
    await db.query(`update listings set currency = 'GBP'`);
    expect(await sweepDisappeared(deps)).toMatchObject({ suspects: 0 });
    expect(calls()).toBe(0);
  });

  it('confirms OUT_OF_STOCK as out_of_stock', async () => {
    const { deps, listing, comps } = await setup({ getItem: async () => SOLD_OUT });
    expect(await sweepDisappeared(deps)).toMatchObject({ soldOut: 1, compsWritten: 1 });
    expect((await listing()).gone_reason).toBe('out_of_stock');
    expect(await comps()).toBe(1);
  });

  it('resets a still-live listing and respects the recheck cooldown', async () => {
    const { db, deps, calls, listing, comps } = await setup({ getItem: async () => ITEM });
    expect(await sweepDisappeared(deps)).toMatchObject({ stillLive: 1, compsWritten: 0 });
    expect(await listing()).toMatchObject({ gone_at: null, miss_count: 0 });
    await db.query('update listings set miss_count = 3');
    expect(await sweepDisappeared(deps)).toMatchObject({ suspects: 0 });
    expect(calls()).toBe(1);
    expect(await comps()).toBe(0);
  });

  it('marks low-confidence suspects window_miss without spending a call', async () => {
    const { deps, calls, listing, comps } = await setup({ confidence: 0.6 });
    expect(await sweepDisappeared(deps)).toMatchObject({ unconfirmed: 1 });
    expect(calls()).toBe(0);
    expect((await listing()).gone_reason).toBe('window_miss');
    expect(await comps()).toBe(0);
  });

  it('marks cheap suspects window_miss without spending a call', async () => {
    const { deps, calls } = await setup({ price: '50.00' });
    expect(await sweepDisappeared(deps)).toMatchObject({ unconfirmed: 1 });
    expect(calls()).toBe(0);
  });

  it('marks stale suspects window_miss (sold time too uncertain)', async () => {
    const { deps, calls } = await setup({ lastSeen: new Date(NOW.getTime() - 25 * 3_600_000) });
    expect(await sweepDisappeared(deps)).toMatchObject({ unconfirmed: 1 });
    expect(calls()).toBe(0);
  });

  it('defers when the aux cap is spent or scanning needs the budget', async () => {
    const capped = await setup({ settings: { auxGetItemDailyCap: 0 } });
    expect(await sweepDisappeared(capped.deps)).toMatchObject({ deferred: 1 });
    expect((await capped.listing()).gone_at).toBeNull();
    const busy = await setup({ mainUsed: 4500 });
    expect(await sweepDisappeared(busy.deps)).toMatchObject({ deferred: 1 });
    expect(busy.calls()).toBe(0);
  });

  it('defers on a getItem error without marking gone', async () => {
    const { deps, listing } = await setup({ getItem: async () => { throw new Error('ebay 500'); } });
    expect(await sweepDisappeared(deps)).toMatchObject({ deferred: 1 });
    expect((await listing()).gone_at).toBeNull();
  });

  it('does nothing while paused', async () => {
    const { deps, calls } = await setup({ settings: { paused: true } });
    expect((await sweepDisappeared(deps)).status).toBe('paused');
    expect(calls()).toBe(0);
  });
});
