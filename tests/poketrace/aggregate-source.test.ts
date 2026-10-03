import { describe, expect, it } from 'vitest';
import { poketraceAggregateSource, tierKey } from '../../src/poketrace/aggregate-source.js';
import { PoketraceHttpError, type PoketraceClient } from '../../src/poketrace/client.js';

const NOW = new Date('2026-10-03T12:00:00Z');
const KEY = { cardId: 'sv03.5-199', grader: 'PSA' as const, grade: 10 };

const tier = (over: Record<string, unknown> = {}) => ({
  avg: 330, low: 280, high: 400, saleCount: 12, median3d: 341, median7d: 338, median30d: 335,
  avg1d: 340, avg7d: 336, avg30d: 332, trend: 'stable', confidence: 'high', ...over,
});
const detail = (prices: Record<string, unknown>, card: Record<string, unknown> = {}) => ({
  data: { id: 'u1', market: 'US', currency: 'USD', lastUpdated: '2026-10-03T09:00:00Z', prices, ...card },
});

function source(
  prices: Record<string, unknown> | null,
  mapped: string | null = 'u1',
  opts: { card?: Record<string, unknown>; maxAgeHours?: number } = {},
) {
  const calls: string[] = [];
  const client: PoketraceClient = {
    async get<T>(path: string) { calls.push(path); return detail(prices ?? {}, opts.card) as T; },
  };
  return {
    calls,
    src: poketraceAggregateSource({ client, resolveId: async () => mapped, now: () => NOW, maxAgeHours: opts.maxAgeHours }),
  };
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

  it('falls back to median7d (7 day window), then avg30d (30 day window)', async () => {
    const { src } = source({ ebay: { PSA_10: tier({ median30d: undefined }) } });
    expect(await src.fetchAggregate(KEY)).toMatchObject({ value: 338, windowDays: 7 });
    const s2 = source({ ebay: { PSA_10: tier({ median30d: undefined, median7d: undefined }) } });
    expect(await s2.src.fetchAggregate(KEY)).toMatchObject({ value: 332, windowDays: 30 });
  });

  it('never values off plain avg (its window is undocumented)', async () => {
    const t = tier({ median30d: undefined, median7d: undefined, avg30d: undefined });
    expect(await source({ ebay: { PSA_10: t } }).src.fetchAggregate(KEY)).toBeNull();
  });

  it("returns null when the vendor's own confidence is low", async () => {
    expect(await source({ ebay: { PSA_10: tier({ confidence: 'low' }) } }).src.fetchAggregate(KEY)).toBeNull();
  });

  describe('freshness (lastUpdated)', () => {
    it('returns null when lastUpdated is missing or unparseable', async () => {
      const p = { ebay: { PSA_10: tier() } };
      expect(await source(p, 'u1', { card: { lastUpdated: undefined } }).src.fetchAggregate(KEY)).toBeNull();
      expect(await source(p, 'u1', { card: { lastUpdated: 'not-a-date' } }).src.fetchAggregate(KEY)).toBeNull();
    });

    it('returns null when older than maxAgeHours (default 72)', async () => {
      const p = { ebay: { PSA_10: tier() } };
      const at = (iso: string, maxAgeHours?: number) =>
        source(p, 'u1', { card: { lastUpdated: iso }, maxAgeHours }).src.fetchAggregate(KEY);
      expect(await at('2026-09-30T12:00:00Z')).not.toBeNull(); // exactly 72h
      expect(await at('2026-09-30T11:59:00Z')).toBeNull();
      expect(await at('2026-10-03T06:00:00Z', 4)).toBeNull();
      expect(await at('2026-10-03T09:00:00Z', 4)).not.toBeNull();
    });

    it('takes asOf from lastUpdated, never from now', async () => {
      const a = await source({ ebay: { PSA_10: tier() } }, 'u1', { card: { lastUpdated: '2026-10-01T00:00:00Z' } })
        .src.fetchAggregate(KEY);
      expect(a!.asOf).toEqual(new Date('2026-10-01T00:00:00Z'));
    });
  });

  describe('market', () => {
    const p = { ebay: { PSA_10: tier() } };
    it('returns null unless the card is the US market', async () => {
      expect(await source(p, 'u1', { card: { market: 'EU' } }).src.fetchAggregate(KEY)).toBeNull();
      expect(await source(p, 'u1', { card: { market: undefined } }).src.fetchAggregate(KEY)).toBeNull();
    });
    it('returns null when the currency is missing (USD is required)', async () => {
      expect(await source(p, 'u1', { card: { currency: undefined } }).src.fetchAggregate(KEY)).toBeNull();
    });
    it('returns null when the currency is not USD, accepting USD case-insensitively', async () => {
      expect(await source(p, 'u1', { card: { currency: 'EUR' } }).src.fetchAggregate(KEY)).toBeNull();
      expect(await source(p, 'u1', { card: { currency: 'usd' } }).src.fetchAggregate(KEY)).not.toBeNull();
    });
  });

  describe('failures', () => {
    it('a mapping failure logs one key-free line and returns null (comps path runs)', async () => {
      const lines: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
      const calls: string[] = [];
      const client: PoketraceClient = { async get<T>(path: string) { calls.push(path); return detail({}) as T; } };
      const src = poketraceAggregateSource({
        client, now: () => NOW,
        resolveId: async () => { throw new Error('poketrace /cards: status 503 body sk-secret'); },
        log: (level, msg, data) => lines.push({ level, msg, data }),
      });
      expect(await src.fetchAggregate(KEY)).toBeNull();
      expect(calls).toEqual([]);
      expect(lines).toHaveLength(1);
      expect(JSON.stringify(lines[0])).not.toContain('sk-secret');
      expect(lines[0]!.data).toMatchObject({ cardId: KEY.cardId });
    });

    it('a mapping failure without a log fn still returns null', async () => {
      const client: PoketraceClient = { async get<T>() { return detail({}) as T; } };
      const src = poketraceAggregateSource({ client, now: () => NOW, resolveId: async () => { throw new Error('x'); } });
      expect(await src.fetchAggregate(KEY)).toBeNull();
    });

    it('a failure fetching the card detail still throws (without invalidating the mapping)', async () => {
      const invalidated: string[] = [];
      const client: PoketraceClient = {
        async get() { throw new PoketraceHttpError('poketrace /cards/u1: status 503', 503); },
      };
      const src = poketraceAggregateSource({
        client, now: () => NOW, resolveId: async () => 'u1', invalidateId: async (id) => { invalidated.push(id); },
      });
      await expect(src.fetchAggregate(KEY)).rejects.toThrow('503');
      expect(invalidated).toEqual([]);
    });

    it('a 404 on the card detail invalidates the mapping and returns null', async () => {
      const invalidated: string[] = [];
      const client: PoketraceClient = {
        async get() { throw new PoketraceHttpError('poketrace /cards/u1: status 404', 404); },
      };
      const src = poketraceAggregateSource({
        client, now: () => NOW, resolveId: async () => 'u1', invalidateId: async (id) => { invalidated.push(id); },
      });
      expect(await src.fetchAggregate(KEY)).toBeNull();
      expect(invalidated).toEqual([KEY.cardId]);
    });

    it('a 404 whose invalidation fails logs one key-free line and still returns null', async () => {
      const lines: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
      const client: PoketraceClient = {
        async get() { throw new PoketraceHttpError('poketrace /cards/u1: status 404', 404); },
      };
      const src = poketraceAggregateSource({
        client, now: () => NOW, resolveId: async () => 'u1',
        invalidateId: async () => { throw new Error('db down body sk-secret'); },
        log: (level, msg, data) => lines.push({ level, msg, data }),
      });
      expect(await src.fetchAggregate(KEY)).toBeNull();
      expect(lines).toHaveLength(1);
      expect(lines[0]!.level).toBe('warn');
      expect(lines[0]!.data).toEqual({ cardId: KEY.cardId });
      expect(JSON.stringify(lines[0])).not.toContain('sk-secret');
    });
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
