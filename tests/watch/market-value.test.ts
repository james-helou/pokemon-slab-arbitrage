import { describe, expect, it, vi } from 'vitest';
import type { ValuationKey } from '../../src/domain/types.js';
import type { AggregatePrice, AggregatePriceSource } from '../../src/oracle/aggregate-source.js';
import { buildWatchReaders, marketValue, ownSalesReader, pptReader, type SourceValue } from '../../src/watch/market-value.js';
import { seedCards } from '../helpers/fixtures.js';
import { createTestDb } from '../helpers/test-db.js';

const KEY: ValuationKey = { cardId: 'sv03.5-199', grader: 'PSA', grade: 10 };
const NOW = new Date('2026-10-28T12:00:00Z');
const sv = (name: string, value: number): SourceValue => ({ name, value, saleCount: 5, asOf: NOW });

describe('marketValue', () => {
  it('takes the highest source and lists every usable one', async () => {
    const mv = await marketValue(KEY, [async () => sv('ppt', 2000), async () => sv('own_sales', 2200)], vi.fn());
    expect(mv).toEqual({ value: 2200, sources: [sv('ppt', 2000), sv('own_sales', 2200)] });
  });

  it('uses the other source when one has nothing', async () => {
    expect(await marketValue(KEY, [async () => null, async () => sv('ppt', 1500)], vi.fn())).toEqual({ value: 1500, sources: [sv('ppt', 1500)] });
  });

  it('is null when no source has a value', async () => {
    expect(await marketValue(KEY, [async () => null, async () => null], vi.fn())).toBeNull();
    expect(await marketValue(KEY, [], vi.fn())).toBeNull();
  });

  it('is deferred when a reader could not try and the others have no value', async () => {
    expect(await marketValue(KEY, [async () => 'deferred', async () => null], vi.fn())).toBe('deferred');
  });

  it('is deferred when a reader could not try even if another has a value (the value must beat every guide)', async () => {
    expect(await marketValue(KEY, [async () => sv('own_sales', 2000), async () => 'deferred'], vi.fn())).toBe('deferred');
  });

  it('stops once the value so far settles the verdict: later (paid) readers are not called', async () => {
    const paid = vi.fn(async () => sv('ppt', 5000));
    const settled = vi.fn((max: number) => max >= 2900);
    const mv = await marketValue(KEY, [async () => sv('own_sales', 2900), paid], vi.fn(), { settled });
    expect(mv).toEqual({ value: 2900, sources: [sv('own_sales', 2900)] });
    expect(paid).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledWith(2900);
  });

  it('a settled value wins over an earlier deferred reader; no value still calls every reader', async () => {
    expect(await marketValue(KEY, [async () => 'deferred', async () => sv('own_sales', 2900)], vi.fn(), { settled: () => true }))
      .toEqual({ value: 2900, sources: [sv('own_sales', 2900)] });
    const paid = vi.fn(async () => sv('ppt', 1000));
    expect(await marketValue(KEY, [async () => null, paid], vi.fn(), { settled: () => true })).toEqual({ value: 1000, sources: [sv('ppt', 1000)] });
    expect(paid).toHaveBeenCalledOnce();
  });

  it('skips and logs a throwing reader', async () => {
    const log = vi.fn();
    const mv = await marketValue(KEY, [async () => { throw new Error('boom'); }, async () => sv('ppt', 900)], log);
    expect(mv).toEqual({ value: 900, sources: [sv('ppt', 900)] });
    expect(log).toHaveBeenCalledWith('warn', expect.any(String), expect.objectContaining({ err: 'boom' }));
  });
});

describe('pptReader', () => {
  const agg = (o: Partial<AggregatePrice>): AggregatePriceSource => ({
    fetchAggregate: async () => ({ value: 2000, low: 1800, high: 2200, saleCount: 5, windowDays: 30, confidence: 0.9, asOf: NOW, sourceName: 'ppt', ...o }),
  });

  it('returns the undiscounted aggregate value', async () => {
    expect(await pptReader(agg({}), 3)(KEY)).toEqual({ name: 'ppt', value: 2000, saleCount: 5, asOf: NOW });
  });

  it('drops too few sales and a missing aggregate', async () => {
    expect(await pptReader(agg({ saleCount: 2 }), 3)(KEY)).toBeNull();
    expect(await pptReader({ fetchAggregate: async () => null }, 3)(KEY)).toBeNull();
  });

  it('is deferred when the source reports it could not try', async () => {
    const deferring: AggregatePriceSource = { fetchAggregate: async (_k, o) => { o?.onDeferred?.(); return null; } };
    expect(await pptReader(deferring, 3)(KEY)).toBe('deferred');
  });
});

describe('buildWatchReaders', () => {
  it('orders the free own-sales reader before PPT', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const fetchAggregate = vi.fn(async () => null);
    const readers = buildWatchReaders({ db, now: () => NOW, minSales: 3, aggregate: { fetchAggregate } });
    expect(readers).toHaveLength(2);
    expect(await readers[0]!(KEY)).toBeNull();
    expect(fetchAggregate).not.toHaveBeenCalled();
    await readers[1]!(KEY);
    expect(fetchAggregate).toHaveBeenCalledOnce();
  });
});

describe('ownSalesReader', () => {
  const comp = (price: number, daysAgo: number, o: { kind?: string; ref?: string; grade?: number } = {}) => ({
    price, soldAt: new Date(NOW.getTime() - daysAgo * 86_400_000), kind: o.kind ?? 'disappearing_bin',
    ref: o.ref ?? `ebay:${price}-${daysAgo}-${o.grade ?? 10}`, grade: o.grade ?? 10,
  });
  async function dbWith(comps: ReturnType<typeof comp>[]) {
    const db = await createTestDb();
    await seedCards(db);
    for (const c of comps) {
      await db.query(
        `insert into comps (card_id, grader, grade, price, sold_at, kind, source_ref) values ('sv03.5-199','PSA',$1,$2,$3,$4,$5)`,
        [c.grade, c.price, c.soldAt, c.kind, c.ref],
      );
    }
    return db;
  }

  it('medians our own sales in the last 90 days, ignoring other grades, old rows, fixtures and paid sources', async () => {
    const db = await dbWith([
      comp(100, 1), comp(200, 2, { kind: 'auction_result', ref: 'ebay_auction:a' }), comp(300, 3), comp(401, 5),
      comp(9999, 100), comp(9999, 1, { grade: 9 }), comp(9999, 1, { ref: 'fixture:x' }), comp(9999, 1, { kind: 'paid_source' }),
    ]);
    const v = await ownSalesReader(db, () => NOW, 3)(KEY);
    expect(v).toEqual({ name: 'own_sales', value: 250, saleCount: 4, asOf: comp(100, 1).soldAt });
  });

  it('rounds the even-count median to cents', async () => {
    const db = await dbWith([comp(100, 1), comp(100.01, 2), comp(100.02, 3), comp(200, 4, { kind: 'auction_result', ref: 'ebay_auction:r' })]);
    expect(await ownSalesReader(db, () => NOW, 3)(KEY)).toMatchObject({ value: 100.02 });
  });

  it('is null without at least one auction_result: disappearing BINs alone are last asks, not sales', async () => {
    const db = await dbWith([comp(100, 1), comp(200, 2), comp(300, 3), comp(400, 4)]);
    expect(await ownSalesReader(db, () => NOW, 3)(KEY)).toBeNull();
  });

  it('is null under the minimum sale count', async () => {
    const db = await dbWith([comp(100, 1), comp(200, 2)]);
    expect(await ownSalesReader(db, () => NOW, 3)(KEY)).toBeNull();
  });
});
