import { describe, expect, it } from 'vitest';
import { addEntry } from '../../src/bankroll/bankroll-repo.js';
import { loadChannels } from '../../src/channels/channels.js';
import type { Valuation } from '../../src/domain/types.js';
import { getRecommendation } from '../../src/ledger/ledger-repo.js';
import { upsertListing } from '../../src/listings/listings-repo.js';
import { silentLog } from '../../src/log.js';
import { evaluateListing } from '../../src/pipeline/evaluate.js';
import { DEFAULT_SETTINGS, type Settings } from '../../src/settings/settings.js';
import type { EbayItemSummary } from '../../src/sources/ebay/ebay-client.js';
import { summaryToListing } from '../../src/sources/ebay/normalize.js';
import { createTestDb } from '../helpers/test-db.js';
import { ITEM, SUMMARY, seedCards } from '../helpers/fixtures.js';

const NOW = new Date('2026-10-03T12:00:00Z');
const VALUATION: Valuation = {
  cardId: 'sv03.5-199', grader: 'PSA', grade: 10, value: 600, low: 592.5, high: 607.5, compCount: 6,
  newestCompAgeDays: 1, confidence: 0.893, compsSource: 'fixture', oracleVersion: 'v1.0.0', computedAt: NOW,
};

type Valuate = (key: unknown, settings: unknown, opts?: { spend?: boolean }) => Promise<Valuation | null>;

async function run(
  raw: number | null | undefined, settings: Partial<Settings> = {}, summary: Partial<EbayItemSummary> = {}, valuate?: Valuate,
) {
  const db = await createTestDb();
  await seedCards(db);
  await addEntry(db, { kind: 'deposit', amount: 500 });
  let valuateCalls = 0;
  let rawCalls = 0;
  const spends: (boolean | undefined)[] = [];
  const deps = {
    db,
    ebay: { getItem: async () => ITEM },
    valuate: async (key: unknown, st: unknown, opts?: { spend?: boolean }) => {
      valuateCalls++;
      spends.push(opts?.spend);
      return valuate ? valuate(key, st, opts) : VALUATION;
    },
    now: () => NOW,
    log: silentLog,
    ...(raw === undefined ? {} : { rawPrice: async () => { rawCalls++; return raw; } }),
  };
  const listing = summaryToListing({ ...SUMMARY, ...summary })!;
  await upsertListing(db, listing, NOW);
  const outcome = await evaluateListing(
    deps, listing, { ...DEFAULT_SETTINGS, buyTaxRate: 0.07, ...settings }, await loadChannels(db),
  );
  return { db, outcome, spends, valuateCalls: () => valuateCalls, rawCalls: () => rawCalls };
}

describe('evaluateListing raw-price pre-filter', () => {
  it('rejects raw_ceiling_below_floor without valuating', async () => {
    const r = await run(5); // PSA 10 ceiling 5 * 25 = 125 < 150
    expect(r.outcome).toMatchObject({ status: 'rejected', reasons: ['raw_ceiling_below_floor'] });
    expect(r.valuateCalls()).toBe(0);
  });

  it('rejects price_above_raw_ceiling without valuating', async () => {
    const r = await run(10); // ceiling 250, 0.8 * 250 = 200 < 350 + shipping
    expect(r.outcome).toMatchObject({ status: 'rejected', reasons: ['price_above_raw_ceiling'] });
    expect(r.valuateCalls()).toBe(0);
  });

  it('runs the ceiling check with the stage-1 shipping estimate when search shipping is null', async () => {
    const r = await run(10, {}, { shippingOptions: [] });
    expect(r.outcome).toMatchObject({ status: 'rejected', reasons: ['price_above_raw_ceiling'] });
    expect(r.valuateCalls()).toBe(0);
  });

  it('passes through when the ceiling is comfortable and adds no flag when graded is above raw', async () => {
    const r = await run(100);
    expect(r.outcome.status).toBe('recommended');
    expect(r.valuateCalls()).toBe(1);
    expect((await getRecommendation(r.db, r.outcome.recommendationId!))?.redFlags).not.toContain('graded_below_raw');
  });

  it('adds graded_below_raw when the valuation is under the raw price', async () => {
    const r = await run(700);
    expect(r.outcome.status).toBe('recommended');
    expect((await getRecommendation(r.db, r.outcome.recommendationId!))?.redFlags).toContain('graded_below_raw');
  });

  it('uses the grade multiplier map, falling back to default', async () => {
    // grade 10 multiplier overridden to 100: ceiling 1000, passes
    const r = await run(10, { rawCeilingMultipliers: { '10': 100, default: 4 } });
    expect(r.outcome.status).toBe('recommended');
  });

  it('is unchanged when raw price is unknown or no dep is wired', async () => {
    const a = await run(null);
    expect(a.outcome.status).toBe('recommended');
    expect(a.rawCalls()).toBe(1);
    expect((await getRecommendation(a.db, a.outcome.recommendationId!))?.redFlags).not.toContain('graded_below_raw');
    expect((await run(undefined)).outcome.status).toBe('recommended');
  });
});

describe('evaluateListing promise triage (spend flag)', () => {
  // SUMMARY is a 350 USD listing; the buy cost is (350 + shipping) * (1 + 0.07 + fx 0). PSA 10 promise multiplier is 8.
  it('passes spend:true for a promising listing (cost <= alertRatio * raw * promise multiplier)', async () => {
    const r = await run(100); // estimate 800, 0.8 * 800 = 640 >= ~375
    expect(r.spends).toEqual([true]);
    expect(r.outcome.status).toBe('recommended');
  });

  it('passes spend:false for an unpromising listing and still uses a cached valuation if one comes back', async () => {
    const r = await run(50); // estimate 400, 0.8 * 400 = 320 < cost; ceiling 1250 still passes the old pre-filter
    expect(r.spends).toEqual([false]);
    expect(r.outcome.status).toBe('recommended');
  });

  it('returns no_valuation with not_promising when the free path has nothing', async () => {
    const r = await run(50, {}, {}, async () => null);
    expect(r.spends).toEqual([false]);
    expect(r.outcome).toEqual({ status: 'no_valuation', reasons: ['not_promising'] });
  });

  it('a promising listing with no valuation keeps the plain no_valuation reason', async () => {
    const r = await run(100, {}, {}, async () => null);
    expect(r.outcome).toEqual({ status: 'no_valuation', reasons: [] });
  });

  it('unknown raw price spends (today\'s behaviour)', async () => {
    const r = await run(null, {}, {}, async () => null);
    expect(r.spends).toEqual([true]);
    expect(r.outcome).toEqual({ status: 'no_valuation', reasons: [] });
  });

  it('uses rawPromiseMultipliers by grade, falling back to default, and includes tax and fx fee in the cost', async () => {
    // raw 100, PSA 10 multiplier overridden to 3: estimate 300, 0.8 * 300 = 240 < cost
    expect((await run(100, { rawPromiseMultipliers: { '10': 3, default: 2 } })).spends).toEqual([false]);
    // multiplier 5: estimate 500 -> 400 >= cost ~375 with tax 0.07 ...
    expect((await run(100, { rawPromiseMultipliers: { '10': 5, default: 2 } })).spends).toEqual([true]);
    // ... but a 10% fx fee pushes cost over 400
    expect((await run(100, { rawPromiseMultipliers: { '10': 5, default: 2 }, fxFeePct: 0.1 })).spends).toEqual([false]);
    // missing grade key falls back to default 2: estimate 200 -> not promising
    expect((await run(100, { rawPromiseMultipliers: { default: 2 } })).spends).toEqual([false]);
  });
});
