import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/db.js';
import { DEFAULT_SETTINGS } from '../../src/settings/settings.js';
import { createSoldCheck, type SoldCheckDeps } from '../../src/soldcheck/sold-check.js';
import { insertSoldCheck, type NewSoldCheck } from '../../src/soldcheck/sold-checks-repo.js';
import { PARSER_VERSION } from '../../src/soldcheck/parse.js';
import { createTestDb } from '../helpers/test-db.js';
import { seedCards } from '../helpers/fixtures.js';
import { soldHtml } from '../helpers/sold-html.js';

const T0 = new Date('2026-10-04T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 3_600_000;
const key = { cardId: 'sv03.5-199', grader: 'PSA' as const, grade: 10 };
const card = { name: 'Charizard ex', number: '199/165', setName: '151' };
const settings = DEFAULT_SETTINGS;
const GOOD = soldHtml([
  { price: 600, sold: 'Oct 2, 2026' }, { price: 620, sold: 'Sep 30, 2026' }, { price: 580, sold: 'Sep 25, 2026' },
]);

interface Call { url: string; init?: RequestInit }

async function harness(opts: { db?: Db; respond?: (url: string) => Response | Promise<Response> } = {}) {
  const db = opts.db ?? (await createTestDb());
  if (!opts.db) await seedCards(db);
  const calls: Call[] = [];
  const logs: { level: string; msg: string }[] = [];
  let t = T0;
  const deps: SoldCheckDeps = {
    db,
    now: () => t,
    log: (level, msg) => { logs.push({ level, msg }); },
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return opts.respond ? opts.respond(url) : new Response(GOOD, { status: 200 });
    }) as unknown as typeof fetch,
  };
  return {
    db, calls, logs, deps, run: createSoldCheck(deps),
    advance: (ms: number) => { t = new Date(t.getTime() + ms); },
  };
}

const rows = async (db: Db) =>
  (await db.query<{ status: string; sale_count: number; parser_version: string; query: string }>(
    'select status, sale_count, parser_version, query from sold_checks order by id',
  )).rows;

const row = (over: Partial<NewSoldCheck> = {}): NewSoldCheck => ({
  ...key, query: 'q', status: 'ok', fetchedAt: T0, saleCount: 6, median: 600, low: 590, high: 610,
  newestSoldAt: new Date('2026-10-02T00:00:00.000Z'), matchedTitles: [], parserVersion: PARSER_VERSION, ...over,
});

describe('createSoldCheck', () => {
  it('fetches the eBay sold search once, plainly, and persists an ok row', async () => {
    const h = await harness();
    const r = await h.run(key, card, settings);
    expect(r).toMatchObject({ status: 'ok', saleCount: 3, median: 600, low: 590, high: 610, fromCache: false });
    expect(r.newestSoldAt).toBe('2026-10-02T00:00:00.000Z');
    expect(h.calls).toHaveLength(1);
    const u = new URL(h.calls[0]!.url);
    expect(u.origin + u.pathname).toBe('https://www.ebay.com/sch/i.html');
    expect(u.searchParams.get('_nkw')).toBe('Charizard ex 199 PSA 10');
    expect(u.searchParams.get('LH_Sold')).toBe('1');
    const init = h.calls[0]!.init!;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init.headers);
    expect([...headers.keys()].sort()).toEqual(['accept', 'accept-language']);
    expect(await rows(h.db)).toEqual([
      { status: 'ok', sale_count: 3, parser_version: PARSER_VERSION, query: 'Charizard ex 199 PSA 10' },
    ]);
  });

  it('persists no_results when nothing matches', async () => {
    const h = await harness({ respond: () => new Response(soldHtml([{ title: 'PSA 9 Charizard ex 199/165 151', price: 300, sold: 'Oct 2, 2026' }])) });
    expect((await h.run(key, card, settings)).status).toBe('no_results');
    expect((await rows(h.db)).map((x) => x.status)).toEqual(['no_results']);
  });

  it('serves a fresh ok row from cache without fetching', async () => {
    const h = await harness();
    await insertSoldCheck(h.db, row({ fetchedAt: new Date(T0.getTime() - 11 * HOUR) }));
    const r = await h.run(key, card, settings);
    expect(r).toMatchObject({ status: 'ok', saleCount: 6, median: 600, fromCache: true });
    expect(h.calls).toHaveLength(0);
    expect(await rows(h.db)).toHaveLength(1);
  });

  it('ignores a cached row older than soldCheckCacheHours', async () => {
    const h = await harness();
    await insertSoldCheck(h.db, row({ fetchedAt: new Date(T0.getTime() - 13 * HOUR) }));
    expect((await h.run(key, card, settings)).fromCache).toBe(false);
    expect(h.calls).toHaveLength(1);
  });

  it('a block opens a 24 h breaker that a new runner instance respects', async () => {
    const h = await harness({ respond: () => new Response('nope', { status: 403 }) });
    expect((await h.run(key, card, settings)).status).toBe('blocked');
    expect((await rows(h.db)).map((x) => x.status)).toEqual(['blocked']);
    expect(h.logs.some((l) => l.level === 'warn')).toBe(true);

    // Restart: a fresh runner over the same DB, 1 h later, does not fetch.
    const h2 = await harness({ db: h.db });
    h2.advance(HOUR);
    expect((await h2.run(key, card, settings)).status).toBe('skipped_blocked');
    expect(h2.calls).toHaveLength(0);
    h2.advance(23 * HOUR + MIN);
    expect((await h2.run(key, card, settings)).status).toBe('ok');
    expect(h2.calls).toHaveLength(1);
  });

  it('treats a challenge page with status 200 as blocked', async () => {
    const h = await harness({ respond: () => new Response('<html>Pardon Our Interruption...</html>', { status: 200 }) });
    expect((await h.run(key, card, settings)).status).toBe('blocked');
  });

  it('skips without fetching once the daily cap is reached (every status counts)', async () => {
    const h = await harness();
    const other = { cardId: 'other', grader: 'PSA' as const, grade: 9 };
    await insertSoldCheck(h.db, row({ ...other, status: 'error', fetchedAt: new Date('2026-10-04T00:00:00.000Z') }));
    await insertSoldCheck(h.db, row({ ...other, status: 'no_results', fetchedAt: new Date('2026-10-04T01:00:00.000Z') }));
    await insertSoldCheck(h.db, row({ ...other, status: 'ok', fetchedAt: new Date('2026-10-03T23:59:00.000Z') }));
    const r = await h.run(key, card, { ...settings, soldCheckDailyCap: 2 });
    expect(r.status).toBe('skipped_budget');
    expect(h.calls).toHaveLength(0);
    expect((await h.run(key, card, { ...settings, soldCheckDailyCap: 3 })).status).toBe('ok');
  });

  it('skips (does not sleep) when the last fetch was under soldCheckMinSpacingSeconds ago', async () => {
    const h = await harness();
    const other = { cardId: 'other', grader: 'PSA' as const, grade: 9 };
    await insertSoldCheck(h.db, row({ ...other, status: 'no_results', fetchedAt: new Date(T0.getTime() - 20_000) }));
    expect((await h.run(key, card, settings)).status).toBe('skipped_rate');
    expect(h.calls).toHaveLength(0);
    h.advance(10_000);
    expect((await h.run(key, card, settings)).status).toBe('ok');
  });

  it('a thrown fetch becomes an error row and never throws', async () => {
    const h = await harness({ respond: () => { throw new Error('socket hang up'); } });
    const r = await h.run(key, card, settings);
    expect(r).toMatchObject({ status: 'error', saleCount: 0, median: null, fromCache: false });
    expect((await rows(h.db)).map((x) => x.status)).toEqual(['error']);
  });

  it('a non-2xx, non-block status is an error row', async () => {
    const h = await harness({ respond: () => new Response('oops', { status: 500 }) });
    expect((await h.run(key, card, settings)).status).toBe('error');
    expect((await rows(h.db)).map((x) => x.status)).toEqual(['error']);
  });

  it('never throws even when the DB fails', async () => {
    const h = await harness();
    const broken: Db = { ...h.db, query: async () => { throw new Error('db down'); } };
    const run = createSoldCheck({ ...h.deps, db: broken });
    expect((await run(key, card, settings)).status).toBe('error');
  });
});
