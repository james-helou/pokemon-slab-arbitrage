import { describe, expect, it } from 'vitest';
import { addEntry } from '../../src/bankroll/bankroll-repo.js';
import { loadChannels } from '../../src/channels/channels.js';
import type { Valuation } from '../../src/domain/types.js';
import { getRecommendation, insertRecommendation } from '../../src/ledger/ledger-repo.js';
import { upsertListing } from '../../src/listings/listings-repo.js';
import { silentLog } from '../../src/log.js';
import { evaluateListing, type EvaluateDeps } from '../../src/pipeline/evaluate.js';
import { DEFAULT_SETTINGS } from '../../src/settings/settings.js';
import { createSoldCheck, type SoldCheck, type SoldCheckResult } from '../../src/soldcheck/sold-check.js';
import { summaryToListing } from '../../src/sources/ebay/normalize.js';
import { createTestDb } from '../helpers/test-db.js';
import { ITEM, SUMMARY, makeNewRecommendation, seedCards } from '../helpers/fixtures.js';

const NOW = new Date('2026-10-03T12:00:00Z');
const VALUATION: Valuation = {
  cardId: 'sv03.5-199', grader: 'PSA', grade: 10, value: 600, low: 592.5, high: 607.5, compCount: 6,
  newestCompAgeDays: 1, confidence: 0.893, compsSource: 'fixture', oracleVersion: 'v1.0.0', computedAt: NOW,
};

const result = (over: Partial<SoldCheckResult> = {}): SoldCheckResult => ({
  status: 'ok', saleCount: 6, median: 590, low: 570, high: 610, newestSoldAt: '2026-10-01T00:00:00.000Z',
  fetchedAt: NOW.toISOString(), fromCache: false, parserVersion: 'v0-unverified', ...over,
});

async function run(opts: { sold?: SoldCheck | ((...a: Parameters<SoldCheck>) => SoldCheckResult); cash?: number; price?: string; seedDuplicate?: boolean } = {}) {
  const db = await createTestDb();
  await seedCards(db);
  await addEntry(db, { kind: 'deposit', amount: opts.cash ?? 500 });
  const calls: Parameters<SoldCheck>[] = [];
  const sold = opts.sold ?? (() => result());
  const deps: EvaluateDeps = {
    db,
    ebay: { getItem: async () => ITEM },
    valuate: async () => VALUATION,
    now: () => NOW,
    log: silentLog,
    soldCheck: async (...a) => { calls.push(a); return sold(...a); },
  };
  const listing = summaryToListing({ ...SUMMARY, price: { value: opts.price ?? '350.00', currency: 'USD' } })!;
  await upsertListing(db, listing, NOW);
  if (opts.seedDuplicate) await insertRecommendation(db, makeNewRecommendation());
  const outcome = await evaluateListing(deps, listing, DEFAULT_SETTINGS, await loadChannels(db));
  const rec = outcome.recommendationId ? await getRecommendation(db, outcome.recommendationId) : null;
  const deliveries = (await db.query<{ route: string }>('select route from alert_deliveries')).rows;
  return { db, outcome, rec, calls, deliveries };
}

describe('evaluateListing with a sold check', () => {
  it('agreeing check: alert unchanged, summary stored, called once with key, card and settings', async () => {
    const { outcome, rec, calls, deliveries } = await run();
    expect(outcome.status).toBe('recommended');
    expect(rec).toMatchObject({ routedTo: 'alerts', redFlags: [] });
    expect(rec!.soldCheck).toMatchObject({ status: 'ok', saleCount: 6, median: 590, verdict: 'agrees' });
    expect(deliveries).toEqual([{ route: 'alerts' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toEqual({ cardId: 'sv03.5-199', grader: 'PSA', grade: 10 });
    expect(calls[0]![1]).toMatchObject({ name: 'Charizard ex', number: '199', setName: '151' });
    expect(calls[0]![2]).toMatchObject({ soldCheckDailyCap: 40, minMatchConfidence: 0.85 });
  });

  it('disagreeing check (value > median x 1.2 with >= 5 sales) demotes to over_budget with a red flag', async () => {
    const { rec, deliveries } = await run({ sold: () => result({ median: 450 }) });
    expect(rec).toMatchObject({ routedTo: 'over_budget', redFlags: ['sold_check_disagrees'] });
    expect(rec!.soldCheck).toMatchObject({ verdict: 'disagrees', median: 450 });
    expect(deliveries).toEqual([{ route: 'over_budget' }]);
  });

  it('exactly at the gap boundary does not disagree', async () => {
    const { rec } = await run({ sold: () => result({ median: 500 }) });
    expect(rec).toMatchObject({ routedTo: 'alerts', redFlags: [] });
  });

  it('too few sales never disagrees', async () => {
    const { rec } = await run({ sold: () => result({ median: 100, saleCount: 4 }) });
    expect(rec).toMatchObject({ routedTo: 'alerts', redFlags: [] });
    expect(rec!.soldCheck).toMatchObject({ verdict: 'insufficient' });
  });

  it('is not called for an over_budget candidate (it cannot be demoted, so it spends no budget)', async () => {
    const { rec, calls, deliveries } = await run({ cash: 100, sold: () => result({ median: 5000 }) });
    expect(rec).toMatchObject({ routedTo: 'over_budget', redFlags: [] });
    expect(rec!.soldCheck).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(deliveries).toEqual([{ route: 'over_budget' }]);
  });

  for (const status of ['blocked', 'error', 'no_results', 'skipped_budget', 'skipped_rate', 'skipped_blocked'] as const) {
    it(`${status} leaves routing unchanged and is stored as unavailable`, async () => {
      const { rec } = await run({ sold: () => result({ status, saleCount: 0, median: null, low: null, high: null }) });
      expect(rec).toMatchObject({ routedTo: 'alerts', redFlags: [] });
      expect(rec!.soldCheck).toMatchObject({ status, verdict: 'unavailable' });
    });
  }

  it('a throwing dep is contained: alert still sent with an error summary', async () => {
    const { outcome, rec } = await run({ sold: () => { throw new Error('boom'); } });
    expect(outcome.status).toBe('recommended');
    expect(rec).toMatchObject({ routedTo: 'alerts', redFlags: [] });
    expect(rec!.soldCheck).toMatchObject({ status: 'error', verdict: 'unavailable' });
  });

  it('is not called when the final score rejects', async () => {
    const { outcome, calls } = await run({ price: '550.00' });
    expect(outcome.status).toBe('rejected');
    expect(calls).toHaveLength(0);
  });

  it('is not called for a listing that already has a recommendation', async () => {
    const { outcome, calls } = await run({ seedDuplicate: true });
    expect(outcome.status).toBe('duplicate');
    expect(calls).toHaveLength(0);
  });

  it('real runner: a fetch that throws writes an error row and the alert is still sent', async () => {
    const db = await createTestDb();
    await seedCards(db);
    await addEntry(db, { kind: 'deposit', amount: 500 });
    const soldCheck = createSoldCheck({
      db, now: () => NOW, log: silentLog,
      fetch: (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch,
    });
    const deps: EvaluateDeps = {
      db, ebay: { getItem: async () => ITEM }, valuate: async () => VALUATION, now: () => NOW, log: silentLog, soldCheck,
    };
    const listing = summaryToListing(SUMMARY)!;
    await upsertListing(db, listing, NOW);
    const outcome = await evaluateListing(deps, listing, DEFAULT_SETTINGS, await loadChannels(db));
    expect(outcome.status).toBe('recommended');
    const rec = await getRecommendation(db, outcome.recommendationId!);
    expect(rec).toMatchObject({ routedTo: 'alerts', soldCheck: { status: 'error', verdict: 'unavailable' } });
    expect((await db.query<{ status: string }>('select status from sold_checks')).rows).toEqual([{ status: 'error' }]);
  });

  it('without the dep, sold_check stays null', async () => {
    const db = await createTestDb();
    await seedCards(db);
    await addEntry(db, { kind: 'deposit', amount: 500 });
    const deps: EvaluateDeps = { db, ebay: { getItem: async () => ITEM }, valuate: async () => VALUATION, now: () => NOW, log: silentLog };
    const listing = summaryToListing(SUMMARY)!;
    await upsertListing(db, listing, NOW);
    const outcome = await evaluateListing(deps, listing, DEFAULT_SETTINGS, await loadChannels(db));
    const { rows } = await db.query<{ sold_check: unknown }>('select sold_check from recommendations where id = $1', [outcome.recommendationId]);
    expect(rows[0]!.sold_check).toBeNull();
    expect((await getRecommendation(db, outcome.recommendationId!))!.soldCheck).toBeUndefined();
  });
});
