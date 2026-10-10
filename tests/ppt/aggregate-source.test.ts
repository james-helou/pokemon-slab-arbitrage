import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/db.js';
import { PptHttpError, PptUnavailableError, type PptClient } from '../../src/ppt/client.js';
import { pacedCredits, parsePptCard, pptAggregateSource, reservePptCredits, type ParseCtx } from '../../src/ppt/aggregate-source.js';
import { createTestDb } from '../helpers/test-db.js';

const NOW = new Date('2026-10-09T12:00:00Z');
const KEY = { cardId: 'sv03.5-199', grader: 'PSA' as const, grade: 10 };
const SECRET = 'ppt-s3cret';

const tcgdexRaw = (variants: unknown[]) => new Response(JSON.stringify({ variants_detailed: variants }), { status: 200 });
const tcgdexOk = (ids: (number | string)[] = [555]) =>
  new Response(JSON.stringify({ variants_detailed: ids.map((id) => ({ thirdParty: { tcgplayer: id } })) }), { status: 200 });

const card = (ebay: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  data: [{ tcgPlayerId: '555', name: 'X', ebay, ...over }],
});
const smart = (price: number, over: Record<string, unknown> = {}) => ({
  price, confidence: 'high', method: '7day_filtered_weighted', daysUsed: 7, ...over,
});
/** Verified v1.0.0 shape. medianPrice/count are LIFETIME fields and must never drive the result (poisoned here on purpose). */
const grade = (over: Record<string, unknown> = {}) => ({
  count: 699, medianPrice: 9999, averagePrice: 9999, minPrice: 1, maxPrice: 99999,
  marketPrice7Day: 305, marketPriceMedian7Day: 310, dailyVolume7Day: 2,
  lastSaleDate: '2026-10-08T00:00:00.000Z', lastMarketUpdate: '2026-10-09T10:00:00.000Z',
  smartMarketPrice: smart(300), ...over,
});

// One PGlite for the file (building one per test dominated the runtime); tables are emptied before each test.
let shared: Db;
beforeAll(async () => { shared = await createTestDb(); });
beforeEach(async () => {
  await shared.query('delete from vendor_credits');
  await shared.query('delete from vendor_card_cache');
});

async function setup(opts: {
  body?: unknown; err?: Error; open?: boolean; cap?: number; burst?: number; ids?: (number | string)[]; tcgdex?: () => Response; now?: () => Date;
} = {}) {
  const db = shared;
  await db.query('delete from vendor_credits');
  await db.query('delete from vendor_card_cache');
  const calls: { path: string; query?: Record<string, string> }[] = [];
  const lines: { level: string; msg: string; data?: Record<string, unknown> }[] = [];
  const client: PptClient = {
    isOpen: () => opts.open ?? false,
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
    ...(opts.burst === undefined ? {} : { burstCredits: async () => opts.burst! }),
    log: (level, msg, data) => { lines.push({ level, msg, data }); },
  });
  return { db, src, calls, lines, tcgdexCalls };
}
const used = async (db: Db) =>
  (await db.query<{ day: string | Date; credits: number }>('select day, credits from vendor_credits')).rows;

describe('reservePptCredits', () => {
  it('reserves up to the cap, refuses beyond, and a new UTC day resets', async () => {
    const db = shared;
    expect(await reservePptCredits(db, '2026-10-09', 2, 5)).toBe(true);
    expect(await reservePptCredits(db, '2026-10-09', 2, 5)).toBe(true);
    expect(await reservePptCredits(db, '2026-10-09', 2, 5)).toBe(false);
    expect((await used(db))[0]!.credits).toBe(4);
    expect(await reservePptCredits(db, '2026-10-10', 2, 5)).toBe(true);
  });
  it('refuses a first insert larger than the cap and writes no row', async () => {
    const db = shared;
    expect(await reservePptCredits(db, '2026-10-09', 2, 1)).toBe(false);
    expect(await used(db)).toHaveLength(0);
  });
  it('concurrent reservations never overspend', async () => {
    const db = shared;
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
    expect(a).toMatchObject({ value: 300, saleCount: 14, windowDays: 7, sourceName: 'ppt', asOf: new Date('2026-10-09T10:00:00Z') });
    expect(a!.confidence).toBeCloseTo(1, 3);
    expect((await used(db))[0]!.credits).toBe(2);
  });

  it('a fresh positive cache row serves every grade without spending or calling', async () => {
    const body = card({ salesByGrade: { psa10: grade(), psa9: grade({ smartMarketPrice: smart(90) }) } });
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

describe('pptAggregateSource review fixes', () => {
  it('a response for a different card is a negative entry (never valued) and the cached body is not stored', async () => {
    const body = card({ salesByGrade: { psa10: grade() } }, { tcgPlayerId: '999' });
    const { src, db, calls, lines } = await setup({ body });
    expect(await src.fetchAggregate(KEY)).toBeNull();
    expect(await src.fetchAggregate(KEY)).toBeNull();
    expect(calls).toHaveLength(1);
    expect((await db.query<{ body: unknown }>('select body from vendor_card_cache')).rows).toEqual([{ body: null }]);
    expect(lines.some((l) => l.msg === 'ppt response is not the requested card')).toBe(true);
  });

  it('a multi-card array is rejected', async () => {
    const one = { tcgPlayerId: '555', ebay: { salesByGrade: { psa10: grade() } } };
    const { src } = await setup({ body: { data: [one, { ...one }] } });
    expect(await src.fetchAggregate(KEY)).toBeNull();
  });

  it('the cache-hit path re-runs the identity check', async () => {
    const { src, db, calls } = await setup();
    await db.query(
      `insert into vendor_card_cache (provider, card_id, fetched_at, body) values ('ppt', $1, $2, $3::jsonb)`,
      [KEY.cardId, NOW, JSON.stringify({ tcgplayerId: '555', response: card({ salesByGrade: { psa10: grade() } }, { tcgPlayerId: '1' }) })],
    );
    expect(await src.fetchAggregate(KEY)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('cache-hit asOf is the row fetched_at when the response has no stamp, and stale rows are rejected', async () => {
    const { src, db } = await setup();
    const fetchedAt = new Date(NOW.getTime() - 20 * 3_600_000);
    await db.query(
      `insert into vendor_card_cache (provider, card_id, fetched_at, body) values ('ppt', $1, $2, $3::jsonb)`,
      [KEY.cardId, fetchedAt, JSON.stringify({ tcgplayerId: '555', response: card({ salesByGrade: { psa10: grade({ lastMarketUpdate: undefined }) } }) })],
    );
    expect((await src.fetchAggregate(KEY))!.asOf).toEqual(fetchedAt);
  });

  it('does not reserve credits or call while the breaker is open', async () => {
    const { src, db, calls, lines } = await setup({ open: true });
    expect(await src.fetchAggregate(KEY)).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await used(db)).toHaveLength(0);
    expect(lines.some((l) => l.level === 'warn')).toBe(true);
  });

  it('a 5xx / network failure writes a 1 hour failed marker, then retries after it', async () => {
    let t = NOW;
    const { src, calls, db } = await setup({ err: new PptHttpError('ppt /cards: status 500', 500), now: () => t });
    await src.fetchAggregate(KEY);
    t = new Date(NOW.getTime() + 30 * 60_000);
    await src.fetchAggregate(KEY);
    expect(calls).toHaveLength(1);
    expect((await db.query<{ kind: string }>('select kind from vendor_card_cache')).rows).toEqual([{ kind: 'failed' }]);
    t = new Date(NOW.getTime() + 61 * 60_000);
    await src.fetchAggregate(KEY);
    expect(calls).toHaveLength(2);
    const net = await setup({ err: new Error('network') });
    await net.src.fetchAggregate(KEY);
    await net.src.fetchAggregate(KEY);
    expect(net.calls).toHaveLength(1);
  });

  it('401/403 latches until the next UTC day: one error log, no further reservations', async () => {
    let t = NOW;
    const { src, calls, lines, db } = await setup({ err: new PptHttpError('ppt /cards: status 401', 401), now: () => t });
    await src.fetchAggregate(KEY);
    await src.fetchAggregate({ ...KEY, cardId: 'b-2' });
    await src.fetchAggregate({ ...KEY, cardId: 'b-3' });
    expect(calls).toHaveLength(1);
    expect((await used(db))[0]!.credits).toBe(2);
    expect(lines.filter((l) => l.level === 'error')).toHaveLength(1);
    t = new Date(NOW.getTime() + 86_400_000);
    await src.fetchAggregate(KEY);
    expect(calls).toHaveLength(2);
  });
});

describe('parsePptCard', () => {
  const CTX: ParseCtx = { now: NOW, tcgplayerId: '555' };
  const P = (body: unknown, key: Parameters<typeof parsePptCard>[1] = KEY, ctx = CTX) => parsePptCard(body, key, ctx);
  const c10 = (over: Record<string, unknown> = {}, ebayExtra: Record<string, unknown> = {}, cardExtra: Record<string, unknown> = {}) =>
    card({ salesByGrade: { psa10: grade(over) }, ...ebayExtra }, cardExtra);

  it('uses only lowercase grader+grade keys under ebay.salesByGrade, decimals as _', () => {
    expect(P(c10())).toMatchObject({ value: 300 });
    expect(P(card({ salesByGrade: { psa8_5: grade({ smartMarketPrice: smart(80) }) } }), { ...KEY, grade: 8.5 })).toMatchObject({ value: 80 });
    expect(P(card({ salesByGrade: { bgs9_5: grade() } }), { ...KEY, grader: 'BGS', grade: 9.5 })).toMatchObject({ value: 300 });
    expect(P(card({ salesByGrade: { PSA10: grade() } }))).toBeNull();
    expect(P(card({ salesByGrade: { psa_10: grade() } }))).toBeNull();
    expect(P(card({ psa10: grade() }))).toBeNull();
  });

  it('takes the value from smartMarketPrice, lowered to marketPriceMedian7Day when that is lower, never lifetime fields', () => {
    expect(P(c10())).toMatchObject({ value: 300, saleCount: 14, windowDays: 7 });
    expect(P(c10({ smartMarketPrice: smart(400) }))).toMatchObject({ value: 310 });
    expect(P(c10({ marketPriceMedian7Day: null }))).toMatchObject({ value: 300 });
    expect(P(c10({ marketPriceMedian7Day: 0 }))).toMatchObject({ value: 300 });
  });

  it('smart price gates: confidence, positive price, daysUsed <= 30, method not all_*', () => {
    expect(P(c10({ smartMarketPrice: smart(300, { confidence: 'low' }) }))).toBeNull();
    expect(P(c10({ smartMarketPrice: smart(300, { confidence: 'medium' }) }))).not.toBeNull();
    expect(P(c10({ smartMarketPrice: smart(0) }))).toBeNull();
    expect(P(c10({ smartMarketPrice: smart(300, { daysUsed: 31 }) }))).toBeNull();
    expect(P(c10({ smartMarketPrice: smart(300, { daysUsed: '7' }) }))).toBeNull();
    expect(P(c10({ smartMarketPrice: smart(300, { daysUsed: 30 }) }))).toMatchObject({ windowDays: 30 });
    expect(P(c10({ smartMarketPrice: smart(300, { method: 'all_filtered_weighted' }) }))).toBeNull();
    expect(P(c10({ smartMarketPrice: undefined }))).toBeNull();
    expect(P(c10({ smartMarketPrice: null }))).toBeNull();
  });

  it('smartPriceOutlierByGrade true is null', () => {
    expect(P(c10({}, { smartPriceOutlierByGrade: { psa10: true } }))).toBeNull();
    expect(P(c10({}, { smartPriceOutlierByGrade: { psa10: false } }))).not.toBeNull();
  });

  it('lastSaleDate must parse and be within 30 days', () => {
    expect(P(c10({ lastSaleDate: '2026-08-06T00:00:00.000Z' }))).toBeNull();
    expect(P(c10({ lastSaleDate: 'garbage' }))).toBeNull();
    expect(P(c10({ lastSaleDate: undefined }))).toBeNull();
    expect(P(c10({ lastSaleDate: '2026-09-10T00:00:00.000Z' }))).not.toBeNull();
  });

  it('saleCount is round(dailyVolume7Day * 7); high confidence is raised to 3, medium is not', () => {
    expect(P(c10({ dailyVolume7Day: 19 / 7 }))).toMatchObject({ saleCount: 19 });
    expect(P(c10({ dailyVolume7Day: 1 / 7 }))).toMatchObject({ saleCount: 3 });
    expect(P(c10({ dailyVolume7Day: 0 }))).toMatchObject({ saleCount: 3 });
    expect(P(c10({ dailyVolume7Day: 1 / 7, smartMarketPrice: smart(300, { confidence: 'medium' }) }))).toMatchObject({ saleCount: 1 });
    expect(P(c10({ dailyVolume7Day: undefined }))).toBeNull();
    expect(P(c10({ dailyVolume7Day: -1 }))).toBeNull();
    expect(P(c10({ dailyVolume7Day: 'x' }))).toBeNull();
  });

  it('low/high bracket the value using marketPrice7Day, not lifetime min/max', () => {
    expect(P(c10({ marketPrice7Day: 350 }))).toMatchObject({ low: 300, high: 350 });
    expect(P(c10({ marketPrice7Day: 250 }))).toMatchObject({ low: 250, high: 300 });
    expect(P(c10({ marketPrice7Day: null }))).toMatchObject({ low: 300, high: 300 });
  });

  it('confidence: 0.4 count + 0.3 recency by daysUsed + 0.3 smart confidence', () => {
    const conf = (n: number, daysUsed: number, confidence: string) =>
      P(c10({ dailyVolume7Day: n / 7, smartMarketPrice: smart(300, { daysUsed, confidence }) }))!.confidence;
    expect(conf(8, 7, 'high')).toBeCloseTo(1, 3);
    expect(conf(4, 14, 'medium')).toBeCloseTo(0.2 + 0.255 + 0.21, 3);
    expect(conf(8, 30, 'high')).toBeCloseTo(0.4 + 0.21 + 0.3, 3);
  });

  it('asOf: grade.lastMarketUpdate, else ebay.updatedAt, else fetchedAt, else now; older than 72h is null', () => {
    expect(P(c10())!.asOf).toEqual(new Date('2026-10-09T10:00:00Z'));
    const noStamp = { lastMarketUpdate: undefined };
    expect(P(c10(noStamp, { updatedAt: '2026-10-08T00:00:00Z' }))!.asOf).toEqual(new Date('2026-10-08T00:00:00Z'));
    expect(P(c10(noStamp))!.asOf).toEqual(NOW);
    const fetchedAt = new Date('2026-10-09T01:00:00Z');
    expect(P(c10(noStamp), KEY, { ...CTX, fetchedAt })!.asOf).toEqual(fetchedAt);
    expect(P(c10({ lastMarketUpdate: '2026-10-06T11:00:00Z' }))).toBeNull();
    expect(P(c10({ lastMarketUpdate: '2026-10-07T13:00:00Z' }))).not.toBeNull();
  });

  it('requires a single card whose tcgPlayerId matches the requested id', () => {
    const g = { salesByGrade: { psa10: grade() } };
    expect(P({ data: { ebay: g } })).toBeNull();
    expect(P({ data: { tcgPlayerId: '556', ebay: g } })).toBeNull();
    expect(P({ data: { tcgPlayerId: '555', ebay: g } })).toMatchObject({ value: 300 });
    expect(P({ data: [{ tcgPlayerId: '555', ebay: g }] })).toMatchObject({ value: 300 });
    expect(P({ data: [{ tcgPlayerId: '555', ebay: g }, { tcgPlayerId: '555', ebay: g }] })).toBeNull();
    expect(P(null)).toBeNull();
    expect(P({ data: [] })).toBeNull();
  });

  it('rejects a non-USD currency, accepts USD or none', () => {
    expect(P(c10({}, {}, { currency: 'CAD' }))).toBeNull();
    expect(P(c10({}, { currency: 'EUR' }))).toBeNull();
    expect(P(c10({}, {}, { currency: 'usd' }))).not.toBeNull();
  });

  it('is null for labelled grades', () => {
    expect(P(card({ salesByGrade: { bgs10: grade() } }), { ...KEY, grader: 'BGS', grade: 10, gradeLabel: 'pristine' })).toBeNull();
  });

  describe('verified real response (swsh7-215 Umbreon VMAX, 2026-10-09)', () => {
    const real = JSON.parse(readFileSync('tests/fixtures/ppt/swsh7-215-umbreon-vmax-2026-10-09.json', 'utf8')) as unknown;
    const R = (grade: number, grader: 'PSA' | 'BGS' | 'CGC' = 'PSA') =>
      parsePptCard(real, { grader, grade }, { now: new Date('2026-10-09T16:00:00Z'), tcgplayerId: '246723' });

    it('PSA 10: min(smart 3873, median7d 3933), 19 sales, 7 day window, high confidence', () => {
      expect(R(10)).toMatchObject({ value: 3873, saleCount: 19, windowDays: 7, sourceName: 'ppt' });
    });
    it('PSA 9: min(1962.5, 1925), 1 sale raised to 3, 14 day window', () => {
      expect(R(9)).toMatchObject({ value: 1925, saleCount: 3, windowDays: 14 });
    });
    it('PSA 8: medium smart 1800 vs median7d 1825 gives 1800, saleCount 3', () => {
      expect(R(8)).toMatchObject({ value: 1800, saleCount: 3 });
    });
    it('PSA 8.5 (one stale lifetime sale, low confidence all_ method) and absent PSA 9.5 are null', () => {
      expect(R(8.5)).toBeNull();
      expect(R(9.5)).toBeNull();
    });
    it('a grade flagged as a smart price outlier is null', () => {
      expect(R(10, 'CGC')).toBeNull();
    });
    it('the wrong requested id is null', () => {
      expect(parsePptCard(real, { grader: 'PSA', grade: 10 }, { now: NOW, tcgplayerId: '1' })).toBeNull();
    });
  });
});

describe('pptAggregateSource spend:false (cache only)', () => {
  const noSpend = { spend: false };

  it('serves a fresh positive cache row for any grade without spending, TCGdex or HTTP', async () => {
    const body = card({ salesByGrade: { psa10: grade(), psa9: grade({ smartMarketPrice: smart(90) }) } });
    const { src, db, calls, tcgdexCalls } = await setup({ body });
    await src.fetchAggregate(KEY); // spends 2 and fills the cache
    expect(await src.fetchAggregate({ ...KEY, grade: 9 }, noSpend)).toMatchObject({ value: 90 });
    expect(calls).toHaveLength(1);
    expect(tcgdexCalls).toHaveLength(1);
    expect((await used(db))[0]!.credits).toBe(2);
  });

  it('returns null with no cache row: no TCGdex, no reservation, no HTTP, no cache write', async () => {
    const { src, db, calls, tcgdexCalls } = await setup();
    expect(await src.fetchAggregate(KEY, noSpend)).toBeNull();
    expect(calls).toHaveLength(0);
    expect(tcgdexCalls).toHaveLength(0);
    expect(await used(db)).toHaveLength(0);
    expect((await db.query('select 1 from vendor_card_cache')).rows).toHaveLength(0);
  });

  it('returns null for a stale positive row, a negative row and a failed row, writing nothing', async () => {
    let t = NOW;
    const { src, db, calls } = await setup({ now: () => t });
    await src.fetchAggregate(KEY);
    t = new Date(NOW.getTime() + 25 * 3_600_000);
    const before = (await db.query('select fetched_at from vendor_card_cache')).rows;
    expect(await src.fetchAggregate(KEY, noSpend)).toBeNull();
    expect((await db.query('select fetched_at from vendor_card_cache')).rows).toEqual(before);
    for (const kind of [null, 'failed']) {
      await db.query(`update vendor_card_cache set body = null, kind = $1, fetched_at = $2`, [kind, t]);
      expect(await src.fetchAggregate(KEY, noSpend)).toBeNull();
    }
    expect(calls).toHaveLength(1);
  });

  it('applies the identity check to the cached row', async () => {
    const { src, db } = await setup();
    await db.query(
      `insert into vendor_card_cache (provider, card_id, fetched_at, body) values ('ppt', $1, $2, $3::jsonb)`,
      [KEY.cardId, NOW, JSON.stringify({ tcgplayerId: '555', response: card({ salesByGrade: { psa10: grade() } }, { tcgPlayerId: '1' }) })],
    );
    expect(await src.fetchAggregate(KEY, noSpend)).toBeNull();
  });

  it('still returns null for labelled grades', async () => {
    const { src } = await setup();
    expect(await src.fetchAggregate({ ...KEY, gradeLabel: 'pristine' }, noSpend)).toBeNull();
  });
});


describe('pacedCredits', () => {
  const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 10, h, m));
  it('ramps from the burst to the daily cap across the UTC day (cap 90, burst 20)', () => {
    expect(pacedCredits(90, 20, at(0))).toBe(20);
    expect(pacedCredits(90, 20, at(6))).toBe(42);
    expect(pacedCredits(90, 20, at(12))).toBe(65);
    expect(pacedCredits(90, 20, at(18))).toBe(87);
    expect(pacedCredits(90, 20, at(23))).toBe(90);
  });
  it('burst 0 starts at nothing, burst >= cap is unpaced, and bad values are clamped', () => {
    expect(pacedCredits(90, 0, at(0))).toBe(0);
    expect(pacedCredits(90, 0, at(12))).toBe(45);
    expect(pacedCredits(90, 90, at(0))).toBe(90);
    expect(pacedCredits(90, 500, at(0))).toBe(90);
    expect(pacedCredits(90, -5, at(0))).toBe(0);
    expect(pacedCredits(0, 20, at(12))).toBe(0);
  });
});

describe('pptAggregateSource pacing', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ ...KEY, cardId: `p-${i}` }));

  it('refuses at the paced cap while the daily cap has room, logs the info line once per hour, then allows later', async () => {
    let t = new Date('2026-10-10T00:00:00Z');
    const { src, calls, lines, db } = await setup({ cap: 90, burst: 20, now: () => t });
    for (const k of ids(12)) await src.fetchAggregate(k);
    expect(calls).toHaveLength(10);
    expect((await used(db))[0]!.credits).toBe(20);
    const paced = lines.filter((l) => l.msg === 'ppt paced credits reached');
    expect(paced).toHaveLength(1);
    expect(paced[0]).toMatchObject({ level: 'info', data: { paced: 20, dailyCap: 90 } });
    expect(lines.some((l) => l.msg === 'ppt daily credit budget exhausted')).toBe(false);
    t = new Date('2026-10-10T01:00:00Z'); // paced 23: one more call fits
    for (const k of ids(14).slice(10)) await src.fetchAggregate(k);
    expect(calls).toHaveLength(11);
    expect(lines.filter((l) => l.msg === 'ppt paced credits reached')).toHaveLength(2);
  });

  it('at the end of the day the daily cap binds and the existing warn is used', async () => {
    const { src, lines } = await setup({ cap: 4, burst: 20, now: () => new Date('2026-10-10T23:00:00Z') });
    for (const k of ids(3)) await src.fetchAggregate(k);
    expect(lines.filter((l) => l.msg === 'ppt daily credit budget exhausted')).toHaveLength(1);
    expect(lines.some((l) => l.msg === 'ppt paced credits reached')).toBe(false);
  });

  it('burst 0 spends nothing at midnight', async () => {
    const { src, calls } = await setup({ cap: 90, burst: 0, now: () => new Date('2026-10-10T00:00:00Z') });
    await src.fetchAggregate(KEY);
    expect(calls).toHaveLength(0);
  });
});


describe('pptAggregateSource variant-aware id', () => {
  it('requests the unlimited id when TCGdex also lists shadowless and copyright prints', async () => {
    const variants = [
      { type: 'holo', subtype: 'unlimited', thirdParty: { tcgplayer: 555 } },
      { type: 'holo', subtype: 'shadowless', thirdParty: { tcgplayer: 777 } },
      { type: 'holo', subtype: '1999-2000-copyright', thirdParty: { tcgplayer: null } },
    ];
    const { src, calls } = await setup({ tcgdex: () => tcgdexRaw(variants) });
    expect(await src.fetchAggregate(KEY)).toMatchObject({ value: 300 });
    expect(calls[0]!.query).toMatchObject({ tcgPlayerId: '555' });
  });

  it('two plain holo ids stay ambiguous: negative cache, no credits', async () => {
    const variants = [{ type: 'holo', thirdParty: { tcgplayer: 1 } }, { type: 'holo', thirdParty: { tcgplayer: 2 } }];
    const { src, db, calls } = await setup({ tcgdex: () => tcgdexRaw(variants) });
    expect(await src.fetchAggregate(KEY)).toBeNull();
    expect(calls).toHaveLength(0);
    expect((await db.query('select 1 from vendor_card_cache where body is null')).rows).toHaveLength(1);
  });
});
