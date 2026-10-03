import { describe, expect, it } from 'vitest';
import { getRecommendation, insertDecision, insertRecommendation } from '../../src/ledger/ledger-repo.js';
import { markGone, upsertListing } from '../../src/listings/listings-repo.js';
import { silentLog } from '../../src/log.js';
import { runOutcomes, type OutcomeDeps } from '../../src/outcomes/outcome-tracker.js';
import { setSetting } from '../../src/settings/settings.js';
import type { EbayItem } from '../../src/sources/ebay/ebay-client.js';
import { summaryToListing } from '../../src/sources/ebay/normalize.js';
import { createTestDb } from '../helpers/test-db.js';
import { ITEM, SUMMARY, makeNewRecommendation, seedCards } from '../helpers/fixtures.js';

const DAY = 86_400_000;

async function setup(o: { mainUsed?: number } = {}) {
  const db = await createTestDb();
  await seedCards(db);
  await upsertListing(db, summaryToListing(SUMMARY)!, new Date('2026-10-03T12:00:00Z'));
  const id = (await insertRecommendation(db, makeNewRecommendation()))!;
  const rec = (await getRecommendation(db, id))!;
  const state = {
    now: new Date(rec.createdAt.getTime() + 8 * DAY),
    item: ITEM as EbayItem | null,
    value: 600 as number | null,
    valuateThrows: false,
    getItemCalls: 0,
  };
  const deps: OutcomeDeps = {
    db,
    ebay: { getItem: async () => { state.getItemCalls++; return state.item; } },
    budget: { limit: 5000, beforeCall: async () => {}, usedToday: async () => o.mainUsed ?? 0 },
    valuate: async (key) => {
      if (state.valuateThrows) throw new Error('comps down');
      if (state.value === null) return null;
      return {
        ...key, value: state.value, low: state.value, high: state.value, compCount: 6, newestCompAgeDays: 1,
        confidence: 0.9, compsSource: 'fixture', oracleVersion: 'v1.0.0', computedAt: state.now,
      };
    },
    now: () => state.now,
    log: silentLog,
  };
  const outcomes = async () =>
    (await db.query<Record<string, unknown>>('select * from outcomes order by horizon_days')).rows;
  return { db, id, rec, state, deps, outcomes };
}

describe('runOutcomes', () => {
  it('writes nothing before the 7-day horizon', async () => {
    const { rec, state, deps } = await setup();
    state.now = new Date(rec.createdAt.getTime() + 6 * DAY);
    expect(await runOutcomes(deps)).toMatchObject({ status: 'ok', due: 0, written: 0 });
    expect(state.getItemCalls).toBe(0);
  });

  it('labels the 7-day outcome from the horizon valuation, exactly once', async () => {
    const { state, deps, outcomes } = await setup();
    expect(await runOutcomes(deps)).toMatchObject({ due: 1, written: 1 });
    const [row] = await outcomes();
    expect(row).toMatchObject({
      horizon_days: 7, listing_final_state: 'live', net_channel: 'ebay', label: 'good',
      label_basis: 'counterfactual', decision: 'none', tracker_version: 'v1.0.0',
    });
    expect(Number(row!.observed_price)).toBe(350);
    expect(Number(row!.market_value_at_horizon)).toBe(600);
    expect(Number(row!.net_at_horizon)).toBe(133.75);
    expect(Number(row!.min_net)).toBe(75);
    expect(await runOutcomes(deps)).toMatchObject({ due: 0, written: 0 });
    expect(state.getItemCalls).toBe(1);
  });

  it('catches up all horizons with one getItem and marks the listing gone', async () => {
    const { db, rec, state, deps, outcomes } = await setup();
    state.now = new Date(rec.createdAt.getTime() + 31 * DAY);
    state.item = null;
    expect(await runOutcomes(deps)).toMatchObject({ due: 1, written: 3 });
    expect((await outcomes()).map((r) => [r.horizon_days, r.listing_final_state])).toEqual([
      [7, 'not_found'], [14, 'not_found'], [30, 'not_found'],
    ]);
    expect(state.getItemCalls).toBe(1);
    const { rows } = await db.query<{ gone_reason: string }>('select gone_reason from listings');
    expect(rows[0]!.gone_reason).toBe('not_found');
  });

  it('trusts an already-confirmed gone listing without calling eBay', async () => {
    const { db, state, deps, outcomes } = await setup();
    await markGone(db, { source: 'ebay', externalId: SUMMARY.itemId }, new Date('2026-10-03T12:05:00Z'), 'out_of_stock');
    await runOutcomes(deps);
    expect((await outcomes())[0]!.listing_final_state).toBe('sold_out');
    expect(state.getItemCalls).toBe(0);
  });

  it('labels marginal then bad as the market moves, and records the decision', async () => {
    const { db, id, rec, state, deps, outcomes } = await setup();
    await insertDecision(db, { recommendationId: id, action: 'pass', reason: 'price', actor: 'james' });
    state.value = 500;
    await runOutcomes(deps);
    state.now = new Date(rec.createdAt.getTime() + 15 * DAY);
    state.value = 400;
    await runOutcomes(deps);
    const rows = await outcomes();
    expect(rows.map((r) => [r.horizon_days, r.label, Number(r.net_at_horizon), r.decision])).toEqual([
      [7, 'marginal', 47, 'pass'], [14, 'bad', -39.75, 'pass'],
    ]);
  });

  it('records no_valuation with a null label when the oracle has no comps', async () => {
    const { state, deps, outcomes } = await setup();
    state.value = null;
    await runOutcomes(deps);
    expect((await outcomes())[0]).toMatchObject({ label: null, label_basis: 'no_valuation', market_value_at_horizon: null });
  });

  it('defers when the aux budget is spent or scanning needs the budget', async () => {
    const capped = await setup();
    await setSetting(capped.db, 'auxGetItemDailyCap', 0);
    expect(await runOutcomes(capped.deps)).toMatchObject({ due: 1, deferred: 1, written: 0 });
    const busy = await setup({ mainUsed: 4500 });
    expect(await runOutcomes(busy.deps)).toMatchObject({ deferred: 1, written: 0 });
    expect(busy.state.getItemCalls).toBe(0);
  });

  it('isolates a failing valuation and retries next run', async () => {
    const { state, deps } = await setup();
    state.valuateThrows = true;
    expect(await runOutcomes(deps)).toMatchObject({ errors: 1, written: 0 });
    state.valuateThrows = false;
    expect(await runOutcomes(deps)).toMatchObject({ written: 1 });
  });

  it('does nothing while paused', async () => {
    const { db, state, deps } = await setup();
    await setSetting(db, 'paused', true);
    expect((await runOutcomes(deps)).status).toBe('paused');
    expect(state.getItemCalls).toBe(0);
  });
});
