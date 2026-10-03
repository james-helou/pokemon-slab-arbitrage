import { describe, expect, it } from 'vitest';
import { sweepDisappeared } from '../../src/disappearing/sweep.js';
import { handleCommand } from '../../src/discord/handlers.js';
import { getRecommendation } from '../../src/ledger/ledger-repo.js';
import { silentLog } from '../../src/log.js';
import { getValuation } from '../../src/oracle/oracle.js';
import { buildOracleDeps } from '../../src/oracle/oracle-wiring.js';
import { runOutcomes } from '../../src/outcomes/outcome-tracker.js';
import type { EvaluateDeps } from '../../src/pipeline/evaluate.js';
import { scanCycle } from '../../src/pipeline/scan-cycle.js';
import { isoWeekOf } from '../../src/reports/iso-week.js';
import { loadReportInput } from '../../src/reports/report-data.js';
import { buildWeeklyReport } from '../../src/reports/weekly.js';
import { createBudget } from '../../src/sources/ebay/budget.js';
import type { EbayItem, EbayItemSummary } from '../../src/sources/ebay/ebay-client.js';
import { createTestDb } from '../helpers/test-db.js';
import { ITEM, SUMMARY, seedCards } from '../helpers/fixtures.js';

const DAY = 86_400_000;

async function setup() {
  const db = await createTestDb();
  await seedCards(db);
  await handleCommand({ db, ebayUsedToday: async () => 0 }, 'deposit', { amount: 500 });
  const clock = { now: new Date('2026-10-03T12:00:00Z') };
  const now = () => clock.now;
  const fetchNever = (async () => { throw new Error('no network in e2e'); }) as unknown as typeof fetch;
  const oracle = await buildOracleDeps(
    { COMPS_SOURCE: 'fixture', POKETRACE_API_KEY: undefined, COMPS_FIXTURE_PATH: 'data/comps-fixture.json' },
    { db, now, log: silentLog, fetch: fetchNever },
  );
  const valuate: EvaluateDeps['valuate'] = (key, s) => getValuation(oracle, key, s);
  const budget = createBudget(db, 'ebay_browse', 5000, now);
  return { db, clock, now, valuate, budget };
}

describe('slice 2 learning loop end to end', () => {
  it('scan -> recommendation -> outcome at 7 days -> weekly report', async () => {
    const { db, clock, now, valuate, budget } = await setup();
    let item: EbayItem | null = ITEM;
    const ebay = { searchNewGraded: async () => [SUMMARY], getItem: async () => item };
    expect((await scanCycle({ db, budget, ebay, valuate, now, log: silentLog }, 0)).outcomes).toEqual({ recommended: 1 });
    const { rows } = await db.query<{ id: number }>('select id from recommendations');
    expect(rows).toHaveLength(1);
    const rec = (await getRecommendation(db, Number(rows[0]!.id)))!;
    expect(rec.valuationSnapshot.compsSource).toBe('fixture+own_db');

    item = null; // the listing sold or ended
    clock.now = new Date(rec.createdAt.getTime() + 8 * DAY);
    expect(await runOutcomes({ db, ebay, budget, valuate, now, log: silentLog })).toMatchObject({ written: 1 });
    const outcomes = await db.query<{ horizon_days: number; listing_final_state: string; label: string | null }>(
      'select horizon_days, listing_final_state, label from outcomes',
    );
    expect(outcomes.rows).toHaveLength(1);
    expect(Number(outcomes.rows[0]!.horizon_days)).toBe(7);
    expect(outcomes.rows[0]!.listing_final_state).toBe('not_found');
    expect(outcomes.rows[0]!.label).not.toBeNull();

    const report = buildWeeklyReport(await loadReportInput(db, isoWeekOf(clock.now), clock.now, 75));
    expect(report.markdown).toContain('- Net > $0: 100% (1/1)');
    expect(report.markdown).toContain('- Listing final state (all outcomes): not_found 1');
    expect(report.markdown).toContain('## Valuation drift (rec-time vs horizon)');
    expect(report.summary).toContain('Valuation drift (rec-time vs horizon):');
    // Found gone 8 days after last sighting: sale time too uncertain, so no comp. (It was also recommended,
    // which excludes it from comps on its own.)
    const comps = await db.query<{ n: number }>(`select count(*)::int as n from comps where kind = 'disappearing_bin'`);
    expect(comps.rows[0]!.n).toBe(0);
  });

  it('a confidently matched listing that vanishes from the window becomes a disappearing_bin comp', async () => {
    const { db, clock, now, valuate, budget } = await setup();
    const anchor: EbayItemSummary = { ...SUMMARY, itemId: 'v1|anchor|0', title: 'Lot of PSA 10 slabs', itemCreationDate: '2026-10-03T11:00:00.000Z' };
    const pricey: EbayItemSummary = { ...SUMMARY, itemId: 'v1|222|0', price: { value: '900.00', currency: 'USD' }, itemCreationDate: '2026-10-03T11:59:00.000Z' };
    let results = [pricey, anchor];
    let getItemCalls = 0;
    const ebay = { searchNewGraded: async () => results, getItem: async () => { getItemCalls++; return null; } };
    const deps = { db, budget, ebay, valuate, now, log: silentLog };
    expect((await scanCycle(deps, 0)).outcomes).toMatchObject({ rejected: 1 }); // overpriced: no stage-2 call
    expect(getItemCalls).toBe(0);
    results = [anchor];
    for (let i = 1; i <= 3; i++) {
      clock.now = new Date(clock.now.getTime() + 90_000);
      expect((await scanCycle(deps, i * 2)).missed).toBe(1);
    }
    expect(await sweepDisappeared({ db, ebay, budget, now, log: silentLog })).toMatchObject({ notFound: 1, compsWritten: 1 });
    expect(getItemCalls).toBe(1);
    const { rows } = await db.query<{ price: string; source_ref: string; card_id: string }>(
      `select price, source_ref, card_id from comps where kind = 'disappearing_bin'`,
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.price)).toBe(900);
    expect(rows[0]!.card_id).toBe('sv03.5-199');
    expect(rows[0]!.source_ref).toBe('ebay:v1|222|0:not_found');
  });
});
