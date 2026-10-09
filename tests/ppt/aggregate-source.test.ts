import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/db.js';
import { PptHttpError, PptUnavailableError, type PptClient } from '../../src/ppt/client.js';
import { parsePptCard, pptAggregateSource, reservePptCredits } from '../../src/ppt/aggregate-source.js';
import { createTestDb } from '../helpers/test-db.js';

const NOW = new Date('2026-10-09T12:00:00Z');
const KEY = { cardId: 'sv03.5-199', grader: 'PSA' as const, grade: 10 };
const SECRET = 'ppt-s3cret';

const tcgdexOk = (ids: (number | string)[] = [555]) =>
  new Response(JSON.stringify({ variants_detailed: ids.map((id) => ({ thirdParty: { tcgplayer: id } })) }), { status: 200 });

const card = (ebay: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  data: [{ tcgPlayerId: '555', name: 'X', ebay, ...over }],
});
const grade = (over: Record<string, unknown> = {}) => ({ medianPrice: 300, averagePrice: 310, salesCount: 12, ...over });

async function setup(opts: {
  body?: unknown; err?: Error; cap?: number; ids?: (number | string)[]; tcgdex?: () => Response; now?: () => Date;
} = {}) {
  const db = await createTestDb();
  const calls: { path: string; query?: Record<string, string> }[] = [];
  const lines: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
  const client: PptClient = {
    async get<T>(path: string, query?: Record<string, string>) {
      calls.push({ path, query });
      if (opts.err) throw opts.err;
      return (opts.body ?? card({ salesByGrade: { psa10: grade() } })) as T;
    },
  };
  const tcgdexCalls: string[] = [];
  const src = pptAggregateSource({
    db, client, now: opts.now ?? (() => NOW),
    fetch: (async (url: string) => { tcgdexCalls.push(url); return opts.tcgdex ? opts.tcgdex() : tcgdexOk(opts.ids); }) as unknown as typeof fetch,
    dailyCredits: async () => opts.cap ?? 90,
    log: (level, msg, data) => { lines.push({ level, msg, data }); },
  });
  return { db, src, calls, lines, tcgdexCalls };
}
const used = async (db: Db) =>
  (await db.query<{ day: string | Date; credits: number }>('select day, credits from vendor_credits')).rows;

describe('reservePptCredits', () => {
  it('reserves up to the cap, refuses beyond, and a new UTC day resets', async () => {
    const db = await createTestDb();
    expect(await reservePptCredits(db, '2026-10-09', 2, 5)).toBe(true);
    expect(await reservePptCredits(db, '2026-10-09', 2, 5)).toBe(true);
    expect(await reservePptCredits(db, '2026-10-09', 2, 5)).toBe(false);
    expect((await used(db))[0]!.credits).toBe(4);
    expect(await reservePptCredits(db, '2026-10-10', 2, 5)).toBe(true);
  });
  it('refuses a first insert larger than the cap and writes no row', async () => {
    const db = await createTestDb();
    expect(await reservePptCredits(db, '2026-10-09', 2, 1)).toBe(false);
    expect(await used(db)).toHaveLength(0);
  });
  it('concurrent reservations never overspend', async () => {
    const db = await createTestDb();
    const results = await Promise.all(Array.from({ length: 10 }, () => reservePptCredits(db, '2026-10-09', 2, 9)));
    expect(results.filter(Boolean)).toHaveLength(4);
    expect((await used(db))[0]!.credits).toBe(8);
  });
});

describe('pptAggregateSource', () => {
  it('values a PSA 10 from one 2-credit call and reserves credits before it', async () => {
    const { src, db, calls } = await setup();
    const a = await src.fetchAggregate(KEY);
    expect(calls).toEqual([{ path: '/cards', query: { tcgPlayerId: '555', includeEbay: 'true', days: '30' } }]);
    expect(a).toMatchObject({ value: 300, saleCount: 12, windowDays: 30, sourceName: 'ppt', asOf: NOW });
    expect(a!.confidence).toBeCloseTo(0.4 * 1 + 0.21 + 0.21, 3);
    expect((await used(db))[0]!.credits).toBe(2);
  });

  it('a fresh positive cache row serves every grade without spending or calling', async () => {
    const body = card({ salesByGrade: { psa10: grade(), psa9: grade({ medianPrice: 90 }) } });
    const { src, db, calls, tcgdexCalls } = await setup({ body });
    await src.fetchAggregate(KEY);
    expect(await src.fetchAggregate({ ...KEY, grade: 9 })).toMatchObject({ value: 90 });
    expect(await src.fetchAggregate({ ...KEY, grade: 8 })).toBeNull();
    expect(calls).toHaveLength(1);
    expect(tcgdexCalls).toHaveLength(1);
    expect((await used(db))[0]!.credits).toBe(2);
  });

  it('refetches when the positive cache row is older than 24h', async () => {
    let t = NOW;
    const { src, db, calls } = await setup({ now: () => t });
    await src.fetchAggregate(KEY);
    t = new Date(NOW.getTime() + 25 * 3_600_000);
    await src.fetchAggregate(KEY);
    expect(calls).toHaveLength(2);
    expect(await used(db)).toHaveLength(2);
  });

  it('no tcgplayer id or several ids: negative cache, null, no credits; honored for 7 days then retried', async () => {
    for (const ids of [[], [1, 2]]) {
      let t = NOW;
      const { src, db, calls, tcgdexCalls } = await setup({ ids, now: () => t });
      expect(await src.fetchAggregate(KEY)).toBeNull();
      expect(await src.fetchAggregate({ ...KEY, grade: 9 })).toBeNull();
      expect(tcgdexCalls).toHaveLength(1);
      expect(calls).toHaveLength(0);
      expect(await used(db)).toHaveLength(0);
      const neg = await db.query<{ body: unknown }>("select body from vendor_card_cache where provider = 'ppt'");
      expect(neg.rows).toEqual([{ body: null }]);
      t = new Date(NOW.getTime() + 8 * 86_400_000);
      await src.fetchAggregate(KEY);
      expect(tcgdexCalls).toHaveLength(2);
    }
  });

  it('empty data is a negative entry that spent its credits and is not refetched', async () => {
    const { src, db, calls } = await setup({ body: { data: [] } });
    expect(await src.fetchAggregate(KEY)).toBeNull();
    expect(await src.fetchAggregate(KEY)).toBeNull();
    expect(calls).toHaveLength(1);
    expect((await used(db))[0]!.credits).toBe(2);
  });

  it('refuses when over the daily budget (read at call time), logging once per UTC day, and makes no call', async () => {
    let t = NOW;
    const { src, calls, lines } = await setup({ cap: 1, now: () => t, ids: [555] });
    expect(await src.fetchAggregate(KEY)).toBeNull();
    expect(await src.fetchAggregate({ ...KEY, cardId: 'other' })).toBeNull();
    expect(calls).toHaveLength(0);
    expect(lines.filter((l) => l.msg === 'ppt daily credit budget exhausted')).toHaveLength(1);
    t = new Date(NOW.getTime() + 86_400_000);
    await src.fetchAggregate(KEY);
    expect(lines.filter((l) => l.msg === 'ppt daily credit budget exhausted')).toHaveLength(2);
  });

  it('stops spending once the cap is hit across cards', async () => {
    const { src, calls } = await setup({ cap: 4 });
    for (const id of ['a-1', 'a-2', 'a-3']) await src.fetchAggregate({ ...KEY, cardId: id });
    expect(calls).toHaveLength(2);
  });

  it('404 caches negative; 500 and breaker return null, keep credits spent, and log key-free', async () => {
    const s404 = await setup({ err: new PptHttpError('ppt /cards: status 404', 404) });
    expect(await s404.src.fetchAggregate(KEY)).toBeNull();
    expect(await s404.src.fetchAggregate(KEY)).toBeNull();
    expect(s404.calls).toHaveLength(1);
    for (const err of [new PptHttpError('ppt /cards: status 500', 500), new PptUnavailableError(), new Error(`boom ${SECRET}`)]) {
      const s = await setup({ err });
      expect(await s.src.fetchAggregate(KEY)).toBeNull();
      expect((await used(s.db))[0]!.credits).toBe(2);
      expect(s.lines.some((l) => l.level === 'warn')).toBe(true);
      expect(JSON.stringify(s.lines)).not.toContain(SECRET);
    }
  });

  it('a tcgdex failure returns null without caching or spending', async () => {
    const { src, db, calls } = await setup({ tcgdex: () => new Response('x', { status: 500 }) });
    expect(await src.fetchAggregate(KEY)).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await used(db)).toHaveLength(0);
    expect((await db.query('select 1 from vendor_card_cache')).rows).toHaveLength(0);
  });

  it('labelled grades are null without any call', async () => {
    const { src, calls, tcgdexCalls } = await setup();
    expect(await src.fetchAggregate({ ...KEY, grader: 'BGS', grade: 10, gradeLabel: 'black_label' })).toBeNull();
    expect(calls).toHaveLength(0);
    expect(tcgdexCalls).toHaveLength(0);
  });
});

describe('parsePptCard', () => {
  const P = (body: unknown, key: Parameters<typeof parsePptCard>[1] = KEY) => parsePptCard(body, key, NOW);

  it('parses both key styles under ebay.salesByGrade and ebay', () => {
    expect(P(card({ salesByGrade: { psa10: grade() } }))).toMatchObject({ value: 300 });
    expect(P(card({ salesByGrade: { PSA10: grade() } }))).toMatchObject({ value: 300 });
    expect(P(card({ psa_10: grade() }))).toMatchObject({ value: 300 });
    expect(P(card({ PSA_10: grade() }))).toMatchObject({ value: 300 });
    expect(P(card({ salesByGrade: { psa9_5: grade({ medianPrice: 150 }) } }), { ...KEY, grade: 9.5 })).toMatchObject({ value: 150 });
    expect(P(card({ 'PSA9.5': grade({ medianPrice: 151 }) }), { ...KEY, grade: 9.5 })).toMatchObject({ value: 151 });
  });

  it('accepts a bare data object and uses a different grader prefix', () => {
    const body = { data: { ebay: { salesByGrade: { bgs9_5: grade() } } } };
    expect(P(body, { ...KEY, grader: 'BGS', grade: 9.5 })).toMatchObject({ value: 300 });
    expect(P(body)).toBeNull();
  });

  it('falls back to averagePrice and rejects non-positive or invalid values', () => {
    expect(P(card({ salesByGrade: { psa10: grade({ medianPrice: undefined }) } }))).toMatchObject({ value: 310 });
    expect(P(card({ salesByGrade: { psa10: grade({ medianPrice: 0, averagePrice: 0 }) } }))).toBeNull();
    expect(P(card({ salesByGrade: { psa10: grade({ medianPrice: 'x', averagePrice: null }) } }))).toBeNull();
    expect(P(card({ salesByGrade: { psa10: { medianPrice: 300 } } }))).toBeNull();
    expect(P(null)).toBeNull();
    expect(P({ data: [] })).toBeNull();
  });

  it('uses count when salesCount is absent', () => {
    expect(P(card({ salesByGrade: { psa10: grade({ salesCount: undefined, count: 7 }) } }))).toMatchObject({ saleCount: 7 });
  });

  it('clamps a lifetime salesCount by dailyVolume7Day * 30', () => {
    const a = P(card({ salesByGrade: { psa10: grade({ salesCount: 400, dailyVolume7Day: 0.2 }) } }));
    expect(a).toMatchObject({ saleCount: 6 });
    const b = P(card({ salesByGrade: { psa10: grade({ salesCount: 4, dailyVolume7Day: 5 }) } }));
    expect(b).toMatchObject({ saleCount: 4 });
  });

  it('takes asOf from a parseable lastUpdated/updatedAt, else now', () => {
    expect(P(card({ salesByGrade: { psa10: grade() } }, { lastUpdated: '2026-10-08T00:00:00Z' }))!.asOf)
      .toEqual(new Date('2026-10-08T00:00:00Z'));
    expect(P(card({ salesByGrade: { psa10: grade() } }, { updatedAt: '2026-10-07T00:00:00Z' }))!.asOf)
      .toEqual(new Date('2026-10-07T00:00:00Z'));
    expect(P(card({ salesByGrade: { psa10: grade() } }, { lastUpdated: 'garbage' }))!.asOf).toEqual(NOW);
  });

  it('is null for labelled grades', () => {
    expect(P(card({ salesByGrade: { bgs10: grade() } }), { ...KEY, grader: 'BGS', grade: 10, gradeLabel: 'pristine' })).toBeNull();
  });
});
