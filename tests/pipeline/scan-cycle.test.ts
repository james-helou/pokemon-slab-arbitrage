import { describe, expect, it } from 'vitest';
import { addEntry } from '../../src/bankroll/bankroll-repo.js';
import { silentLog } from '../../src/log.js';
import { scanCycle, type ScanDeps } from '../../src/pipeline/scan-cycle.js';
import { setSetting } from '../../src/settings/settings.js';
import type { Budget } from '../../src/sources/ebay/budget.js';
import { createTestDb } from '../helpers/test-db.js';
import { ITEM, SUMMARY, seedCards } from '../helpers/fixtures.js';

const NOW = new Date('2026-10-03T12:00:00Z');

async function setup(opts: { used?: number; valuateThrows?: boolean } = {}) {
  const db = await createTestDb();
  await seedCards(db);
  await addEntry(db, { kind: 'deposit', amount: 500 });
  const budget: Budget = { limit: 5000, beforeCall: async () => {}, usedToday: async () => opts.used ?? 0 };
  const deps: ScanDeps = {
    db,
    budget,
    ebay: {
      searchNewGraded: async () => [SUMMARY, { ...SUMMARY, itemId: 'v1|222|0', title: 'Lot of PSA 10 slabs' }],
      getItem: async () => ITEM,
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
});
