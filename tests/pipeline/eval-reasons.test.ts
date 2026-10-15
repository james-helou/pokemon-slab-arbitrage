import { describe, expect, it } from 'vitest';
import { addEntry } from '../../src/bankroll/bankroll-repo.js';
import { loadChannels } from '../../src/channels/channels.js';
import type { Valuation } from '../../src/domain/types.js';
import { recordEvalOutcome, upsertListing } from '../../src/listings/listings-repo.js';
import { silentLog } from '../../src/log.js';
import { evaluateListing, type EvaluateDeps } from '../../src/pipeline/evaluate.js';
import { ingestListing, type IngestSummary } from '../../src/pipeline/ingest.js';
import { DEFAULT_SETTINGS } from '../../src/settings/settings.js';
import { summaryToListing } from '../../src/sources/ebay/normalize.js';
import { createTestDb } from '../helpers/test-db.js';
import { ITEM, SUMMARY, seedCards } from '../helpers/fixtures.js';

const NOW = new Date('2026-10-03T12:00:00Z');
const VALUATION: Valuation = {
  cardId: 'sv03.5-199', grader: 'PSA', grade: 10, value: 600, low: 592.5, high: 607.5, compCount: 6,
  newestCompAgeDays: 1, confidence: 0.893, compsSource: 'fixture', oracleVersion: 'v1.0.0', computedAt: NOW,
};
const SETTINGS = { ...DEFAULT_SETTINGS, buyTaxRate: 0.07 };

async function setup() {
  const db = await createTestDb();
  await seedCards(db);
  await addEntry(db, { kind: 'deposit', amount: 500 });
  const deps: EvaluateDeps = {
    db, ebay: { getItem: async () => ITEM }, valuate: async () => VALUATION, now: () => NOW, log: silentLog,
  };
  return { db, deps, channels: await loadChannels(db) };
}

const listingAt = (price: string) => summaryToListing({ ...SUMMARY, price: { value: price, currency: 'USD' } })!;

async function evalRow(db: Awaited<ReturnType<typeof setup>>['db']) {
  const { rows } = await db.query<{ eval_status: string | null; eval_reasons: string[] | null; eval_detail: Record<string, number> | null }>(
    `select eval_status, eval_reasons, eval_detail from listings where external_id = $1`, [SUMMARY.itemId],
  );
  return rows[0]!;
}

describe('evaluation reasons', () => {
  it('a score rejection carries the numbers behind it', async () => {
    const { db, deps, channels } = await setup();
    const listing = listingAt('560.00');
    await upsertListing(db, listing, NOW);
    const outcome = await evaluateListing(deps, listing, SETTINGS, channels);
    expect(outcome.status).toBe('rejected');
    expect(outcome.reasons).toContain('price_above_alert_ratio');
    expect(outcome.detail).toMatchObject({ price: 560, value: 600 });
    expect(outcome.detail?.buyTotal).toBeGreaterThan(560);
    expect(typeof outcome.detail?.bestNet).toBe('number');
    expect(typeof outcome.detail?.roi).toBe('number');
  });

  it('recordEvalOutcome stores status, reasons and detail on the listing', async () => {
    const { db } = await setup();
    const listing = listingAt('350.00');
    await upsertListing(db, listing, NOW);
    await recordEvalOutcome(db, listing, { status: 'rejected', reasons: ['net_below_min'], detail: { price: 350, value: 600 } });
    expect(await evalRow(db)).toEqual({ eval_status: 'rejected', eval_reasons: ['net_below_min'], eval_detail: { price: 350, value: 600 } });
    await recordEvalOutcome(db, listing, { status: 'no_match', reasons: [] });
    expect(await evalRow(db)).toEqual({ eval_status: 'no_match', eval_reasons: [], eval_detail: null });
  });

  it('ingestListing records the outcome of every evaluation', async () => {
    const { db, deps, channels } = await setup();
    const summary: IngestSummary = { new: 0, errors: 0, outcomes: {} };
    await ingestListing(deps, listingAt('560.00'), SETTINGS, channels, summary);
    const row = await evalRow(db);
    expect(row.eval_status).toBe('rejected');
    expect(row.eval_reasons).toContain('price_above_alert_ratio');
    expect(row.eval_detail).toMatchObject({ price: 560, value: 600 });
  });

  it('records a recommendation as recommended', async () => {
    const { db, deps, channels } = await setup();
    await ingestListing(deps, listingAt('350.00'), SETTINGS, channels, { new: 0, errors: 0, outcomes: {} });
    expect((await evalRow(db)).eval_status).toBe('recommended');
  });
});
