import { describe, expect, it } from 'vitest';
import type { AggregatePriceSource, AggregatePrice } from '../../src/oracle/aggregate-source.js';
import { fixtureCompsSource } from '../../src/oracle/comps-source.js';
import { getValuation } from '../../src/oracle/oracle.js';
import { DEFAULT_SETTINGS } from '../../src/settings/settings.js';
import { createTestDb } from '../helpers/test-db.js';
import { seedCards } from '../helpers/fixtures.js';

const KEY = { cardId: 'sv03.5-199', grader: 'PSA' as const, grade: 10 };
const NOW = new Date('2026-10-03T12:00:00Z');
const clock = () => NOW;

const agg = (over: Partial<AggregatePrice> = {}): AggregatePrice => ({
  value: 335, low: 280, high: 400, saleCount: 12, windowDays: 30, confidence: 0.8, asOf: NOW, sourceName: 'poketrace', ...over,
});
const aggSource = (r: AggregatePrice | null | Error): AggregatePriceSource & { calls: number; opts: unknown[] } => {
  const s = {
    calls: 0, opts: [] as unknown[],
    fetchAggregate: async (_k: unknown, opts?: unknown) => { s.calls++; s.opts.push(opts); if (r instanceof Error) throw r; return r; },
  };
  return s;
};
const comps = fixtureCompsSource([{ ...KEY, sales: [100, 110, 120, 130].map((price, i) => ({ price, daysAgo: i + 1 })) }], clock);

describe('getValuation with an aggregate source', () => {
  it('uses the aggregate when saleCount >= minCompCount and persists it as poketrace', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const aggregate = aggSource(agg());
    const settings = { ...DEFAULT_SETTINGS, boDiscount: 1 };
    const v = await getValuation({ db, source: comps, aggregate, now: clock }, KEY, settings);
    expect(v).toMatchObject({
      value: 335, low: 280, high: 400, compCount: 12, newestCompAgeDays: 0, confidence: 0.8, compsSource: 'poketrace',
    });
    const { rows } = await db.query<{ comps_source: string }>('select comps_source from valuations');
    expect(rows).toEqual([{ comps_source: 'poketrace' }]);
    const cached = await getValuation({ db, source: comps, aggregate, now: clock }, KEY, settings);
    expect(cached?.compsSource).toBe('poketrace');
    expect(aggregate.calls).toBe(1);
  });

  it('applies the Best Offer discount to value, low and high before persisting (eBay sold prices hide BO)', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const aggregate = aggSource(agg({ value: 300, low: 200, high: 400 }));
    const v = await getValuation({ db, source: comps, aggregate, now: clock }, KEY, { ...DEFAULT_SETTINGS, boDiscount: 0.85 });
    expect(v).toMatchObject({ value: 255, low: 170, high: 340 });
    const { rows } = await db.query<{ value: string; low: string; high: string }>('select value, low, high from valuations');
    expect(rows.map((r) => [Number(r.value), Number(r.low), Number(r.high)])).toEqual([[255, 170, 340]]);
  });

  it('falls back to comps when saleCount is below minCompCount', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const aggregate = aggSource(agg({ saleCount: DEFAULT_SETTINGS.minCompCount - 1 }));
    const v = await getValuation({ db, source: comps, aggregate, now: clock }, KEY, DEFAULT_SETTINGS);
    expect(v).toMatchObject({ value: 115, compsSource: 'fixture' });
  });

  it('falls back to comps when the aggregate is null', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const v = await getValuation({ db, source: comps, aggregate: aggSource(null), now: clock }, KEY, DEFAULT_SETTINGS);
    expect(v?.compsSource).toBe('fixture');
  });

  it('fails the valuation when the aggregate throws (no partial data)', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const aggregate = aggSource(new Error('poketrace /cards/x: status 503'));
    await expect(getValuation({ db, source: comps, aggregate, now: clock }, KEY, DEFAULT_SETTINGS)).rejects.toThrow('503');
    const { rows } = await db.query('select 1 from valuations');
    expect(rows).toHaveLength(0);
  });

  it("sets newestCompAgeDays from the aggregate's asOf age in days, not its window", async () => {
    const db = await createTestDb();
    await seedCards(db);
    const asOf = new Date(NOW.getTime() - 36 * 3_600_000);
    const v = await getValuation({ db, source: comps, aggregate: aggSource(agg({ asOf, windowDays: 30 })), now: clock }, KEY, DEFAULT_SETTINGS);
    expect(v?.newestCompAgeDays).toBe(1.5);
  });
});

describe('getValuation spend flag', () => {
  it('forwards spend to the aggregate source, defaulting to spend:true behaviour (no option)', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const aggregate = aggSource(null);
    await getValuation({ db, source: comps, aggregate, now: clock }, KEY, DEFAULT_SETTINGS);
    await getValuation({ db, source: comps, aggregate, now: clock }, { ...KEY, grade: 9 }, DEFAULT_SETTINGS, { spend: false });
    expect(aggregate.opts[0]).toBeUndefined();
    expect(aggregate.opts[1]).toEqual({ spend: false });
  });

  it('a cached valuation does not consult the aggregate at all, with or without spend', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const aggregate = aggSource(agg());
    await getValuation({ db, source: comps, aggregate, now: clock }, KEY, DEFAULT_SETTINGS);
    await getValuation({ db, source: comps, aggregate, now: clock }, KEY, DEFAULT_SETTINGS, { spend: false });
    expect(aggregate.calls).toBe(1);
  });

  it('spend:false does not persist an own-comps valuation (it would block the vendor until it ages out); default still does', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const aggregate = aggSource(null);
    const free = await getValuation({ db, source: comps, aggregate, now: clock }, KEY, DEFAULT_SETTINGS, { spend: false });
    expect(free).toMatchObject({ compsSource: 'fixture' });
    expect((await db.query('select 1 from valuations')).rows).toHaveLength(0);
    await getValuation({ db, source: comps, aggregate, now: clock }, KEY, DEFAULT_SETTINGS);
    expect((await db.query('select 1 from valuations')).rows).toHaveLength(1);
  });
});
