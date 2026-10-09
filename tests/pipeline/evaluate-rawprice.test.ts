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

async function run(raw: number | null | undefined, settings: Partial<Settings> = {}, summary: Partial<EbayItemSummary> = {}) {
  const db = await createTestDb();
  await seedCards(db);
  await addEntry(db, { kind: 'deposit', amount: 500 });
  let valuateCalls = 0;
  let rawCalls = 0;
  const deps = {
    db,
    ebay: { getItem: async () => ITEM },
    valuate: async () => { valuateCalls++; return VALUATION; },
    now: () => NOW,
    log: silentLog,
    ...(raw === undefined ? {} : { rawPrice: async () => { rawCalls++; return raw; } }),
  };
  const listing = summaryToListing({ ...SUMMARY, ...summary })!;
  await upsertListing(db, listing, NOW);
  const outcome = await evaluateListing(
    deps, listing, { ...DEFAULT_SETTINGS, buyTaxRate: 0.07, ...settings }, await loadChannels(db),
  );
  return { db, outcome, valuateCalls: () => valuateCalls, rawCalls: () => rawCalls };
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
