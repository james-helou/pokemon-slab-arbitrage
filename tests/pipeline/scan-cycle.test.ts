import { describe, expect, it } from 'vitest';
import { addEntry } from '../../src/bankroll/bankroll-repo.js';
import { silentLog } from '../../src/log.js';
import { scanCycle, type ScanDeps } from '../../src/pipeline/scan-cycle.js';
import { setSetting } from '../../src/settings/settings.js';
import type { Budget } from '../../src/sources/ebay/budget.js';
import { createTestDb } from '../helpers/test-db.js';
import type { EbayItemSummary } from '../../src/sources/ebay/ebay-client.js';
import { ITEM, SUMMARY, seedCards } from '../helpers/fixtures.js';

const NOW = new Date('2026-10-03T12:00:00Z');

async function setup(opts: { used?: number; valuateThrows?: boolean; getItemThrows?: () => boolean; results?: EbayItemSummary[] } = {}) {
  const db = await createTestDb();
  await seedCards(db);
  await addEntry(db, { kind: 'deposit', amount: 500 });
  const budget: Budget = { limit: 5000, beforeCall: async () => {}, usedToday: async () => opts.used ?? 0 };
  const deps: ScanDeps = {
    db,
    budget,
    ebay: {
      searchNewGraded: async () =>
        opts.results ?? [SUMMARY, { ...SUMMARY, itemId: 'v1|222|0', title: 'Lot of PSA 10 slabs' }],
      getItem: async () => {
        if (opts.getItemThrows?.()) throw new Error('ebay 500');
        return ITEM;
      },
    },
    valuate: async (key) => {
      if (opts.valuateThrows) throw new Error('comps down');
      return {
        ...key, value: 600, low: 590, high: 610, compCount: 6, newestCompAgeDays: 1, confidence: 0.9,
        compsSource: 'fixture', oracleVersion: 'v1.0.0', computedAt: NOW,
      };
    },
    now: () => NOW,
    log: silentLog,
  };
  return { db, deps };
}

describe('scanCycle', () => {
  it('evaluates only new listings', async () => {
    const { deps } = await setup();
    const first = await scanCycle(deps, 0);
    expect(first).toMatchObject({ status: 'ok', seen: 2, new: 2, errors: 0 });
    expect(first.outcomes).toEqual({ recommended: 1, no_match: 1 });
    const second = await scanCycle(deps, 1);
    expect(second).toMatchObject({ seen: 2, new: 0 });
  });

  it('does nothing while paused', async () => {
    const { db, deps } = await setup();
    await setSetting(db, 'paused', true);
    expect((await scanCycle(deps, 0)).status).toBe('paused');
  });

  it('skips odd cycles above 90% of the API budget', async () => {
    const { deps } = await setup({ used: 4600 });
    expect((await scanCycle(deps, 1)).status).toBe('throttled');
    expect((await scanCycle(deps, 2)).status).toBe('ok');
  });

  it('counts per-listing errors and never recommends on a failed valuation', async () => {
    const { db, deps } = await setup({ valuateThrows: true });
    const r = await scanCycle(deps, 0);
    expect(r.errors).toBe(1);
    const { rows } = await db.query<{ n: number }>('select count(*)::int as n from recommendations');
    expect(rows[0]!.n).toBe(0);
  });

  it('skips listings that normalize to null', async () => {
    const eur: EbayItemSummary = { ...SUMMARY, itemId: 'v1|333|0', price: { value: '350.00', currency: 'EUR' } };
    const { db, deps } = await setup({ results: [eur, SUMMARY] });
    const r = await scanCycle(deps, 0);
    expect(r).toMatchObject({ seen: 2, new: 1, errors: 0 });
    const { rows } = await db.query('select 1 from listings');
    expect(rows).toHaveLength(1);
  });

  it('retries a listing whose evaluation threw, then recommends', async () => {
    let fail = true;
    const { db, deps } = await setup({ results: [SUMMARY], getItemThrows: () => fail });
    expect((await scanCycle(deps, 0)).errors).toBe(1);
    fail = false;
    const second = await scanCycle(deps, 2);
    expect(second.outcomes).toEqual({ recommended: 1 });
    const { rows } = await db.query<{ n: number }>('select count(*)::int as n from recommendations');
    expect(rows[0]!.n).toBe(1);
    expect((await scanCycle(deps, 4)).outcomes).toEqual({});
  });

  it('stops retrying after 3 failed attempts', async () => {
    const { db, deps } = await setup({ results: [SUMMARY], getItemThrows: () => true });
    const errors: number[] = [];
    for (let i = 0; i < 5; i++) errors.push((await scanCycle(deps, i * 2)).errors);
    expect(errors).toEqual([1, 1, 1, 0, 0]);
    const { rows } = await db.query<{ eval_attempts: number }>('select eval_attempts from listings');
    expect(rows[0]!.eval_attempts).toBe(3);
  });

  it('counts misses for listings that vanish from the newest-first window', async () => {
    const lot = (id: string, listed: string): EbayItemSummary => ({
      ...SUMMARY, itemId: id, title: 'Lot of PSA 10 slabs', itemCreationDate: listed,
    });
    const A = lot('v1|A|0', '2026-10-03T11:50:00.000Z'); // window floor anchor
    const B = lot('v1|B|0', '2026-10-03T11:55:00.000Z');
    const C = lot('v1|C|0', '2026-10-03T11:58:00.000Z');
    const { db, deps } = await setup();
    let results = [A, B, C];
    deps.ebay = { ...deps.ebay, searchNewGraded: async () => results };
    expect((await scanCycle(deps, 0)).missed).toBe(0);
    results = [A, C];
    for (let i = 1; i <= 3; i++) expect((await scanCycle(deps, i * 2)).missed).toBe(1);
    const miss = await db.query<{ miss_count: number }>(`select miss_count from listings where external_id = 'v1|B|0'`);
    expect(miss.rows[0]!.miss_count).toBe(3);
    results = [A, B, C];
    expect((await scanCycle(deps, 8)).missed).toBe(0);
    const reset = await db.query<{ miss_count: number }>(`select miss_count from listings where external_id = 'v1|B|0'`);
    expect(reset.rows[0]!.miss_count).toBe(0);
  });
});
