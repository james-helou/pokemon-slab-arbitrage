import { describe, expect, it } from 'vitest';
import { poketraceAggregateSource, tierKey } from '../../src/poketrace/aggregate-source.js';
import type { PoketraceClient } from '../../src/poketrace/client.js';

const NOW = new Date('2026-10-03T12:00:00Z');
const KEY = { cardId: 'sv03.5-199', grader: 'PSA' as const, grade: 10 };

const tier = (over: Record<string, unknown> = {}) => ({
  avg: 330, low: 280, high: 400, saleCount: 12, median3d: 341, median7d: 338, median30d: 335,
  avg1d: 340, avg7d: 336, avg30d: 332, trend: 'stable', confidence: 'high', ...over,
});
const detail = (prices: Record<string, unknown>) => ({
  data: { id: 'u1', lastUpdated: '2026-10-03T09:00:00Z', prices },
});

function source(prices: Record<string, unknown> | null, mapped: string | null = 'u1') {
  const calls: string[] = [];
  const client: PoketraceClient = {
    async get<T>(path: string) { calls.push(path); return detail(prices ?? {}) as T; },
  };
  return { calls, src: poketraceAggregateSource({ client, resolveId: async () => mapped, now: () => NOW }) };
}

describe('tierKey', () => {
  it('maps grader and grade, with 9.5 as 9_5', () => {
    expect(tierKey({ ...KEY })).toBe('PSA_10');
    expect(tierKey({ ...KEY, grader: 'CGC', grade: 9.5 })).toBe('CGC_9_5');
    expect(tierKey({ ...KEY, grader: 'BGS', grade: 10 })).toBe('BGS_10');
    expect(tierKey({ ...KEY, grader: 'SGC', grade: 9 })).toBe('SGC_9');
  });
  it('has no tier for labelled grades (naming unverified)', () => {
    expect(tierKey({ ...KEY, grader: 'BGS', grade: 10, gradeLabel: 'black_label' })).toBeNull();
  });
});

describe('poketraceAggregateSource', () => {
  it('prefers median30d and uses a 30 day window', async () => {
    const { src, calls } = source({ ebay: { PSA_10: tier() } });
    const a = await src.fetchAggregate(KEY);
    expect(calls).toEqual(['/cards/u1']);
    expect(a).toMatchObject({
      value: 335, low: 280, high: 400, saleCount: 12, windowDays: 30, sourceName: 'poketrace', asOf: new Date('2026-10-03T09:00:00Z'),
    });
    expect(a!.confidence).toBeGreaterThan(0);
  });

  it('falls back to median7d (7 day window), then avg (30 day window, the widest)', async () => {
    const { src } = source({ ebay: { PSA_10: tier({ median30d: undefined }) } });
    expect(await src.fetchAggregate(KEY)).toMatchObject({ value: 338, windowDays: 7 });
    const s2 = source({ ebay: { PSA_10: tier({ median30d: undefined, median7d: undefined }) } });
    expect(await s2.src.fetchAggregate(KEY)).toMatchObject({ value: 330, windowDays: 30 });
  });

  it('confidence combines vendor confidence with a count score (count/8, capped)', async () => {
    const hi = await source({ ebay: { PSA_10: tier({ saleCount: 8, confidence: 'high' }) } }).src.fetchAggregate(KEY);
    const med = await source({ ebay: { PSA_10: tier({ saleCount: 8, confidence: 'medium' }) } }).src.fetchAggregate(KEY);
    const few = await source({ ebay: { PSA_10: tier({ saleCount: 2, confidence: 'high' }) } }).src.fetchAggregate(KEY);
    const many = await source({ ebay: { PSA_10: tier({ saleCount: 80, confidence: 'high' }) } }).src.fetchAggregate(KEY);
    expect(hi!.confidence).toBeGreaterThan(med!.confidence);
    expect(hi!.confidence).toBeGreaterThan(few!.confidence);
    expect(many!.confidence).toBe(hi!.confidence);
    expect(hi!.confidence).toBeLessThanOrEqual(1);
  });

  it('returns null when the card is unmapped or the tier is absent or has no price', async () => {
    expect(await source({ ebay: { PSA_10: tier() } }, null).src.fetchAggregate(KEY)).toBeNull();
    expect(await source({ ebay: { PSA_9: tier() } }).src.fetchAggregate(KEY)).toBeNull();
    expect(await source({ tcgplayer: { PSA_10: tier() } }).src.fetchAggregate(KEY)).toBeNull();
    expect(await source({ ebay: { PSA_10: { saleCount: 3 } } }).src.fetchAggregate(KEY)).toBeNull();
  });

  it('returns null for labelled grades without calling the API', async () => {
    const { src, calls } = source({ ebay: { BGS_10: tier() } });
    expect(await src.fetchAggregate({ ...KEY, grader: 'BGS', gradeLabel: 'pristine' })).toBeNull();
    expect(calls).toEqual([]);
  });
});
