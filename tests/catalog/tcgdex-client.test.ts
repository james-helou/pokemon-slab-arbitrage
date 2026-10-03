import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fetchAllCards } from '../../src/catalog/tcgdex-client.js';
import { silentLog } from '../../src/log.js';

const fx = (n: string): unknown => JSON.parse(readFileSync(`tests/fixtures/tcgdex/${n}.json`, 'utf8'));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

type Handler = (url: string, n: number) => Response;

function fakeFetch(handlers: Record<string, Handler>) {
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const inits: (RequestInit | undefined)[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    inits.push(init);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    const h = handlers[url.replace('https://api.tcgdex.net/v2/en', '')];
    if (!h) return json({}, 404);
    return h(url, calls.filter((c) => c === url).length);
  }) as unknown as typeof fetch;
  return { fn, calls, inits, maxInFlight: () => maxInFlight };
}

const noSleep = { sleep: async () => {} };
const okSets = (ids: string[]) => ({
  '/sets': () => json((fx('sets') as { id: string }[]).filter((s) => ids.includes(s.id))),
});

describe('tcgdex client', () => {
  it('maps set cards to catalog rows using the English API', async () => {
    const f = fakeFetch({ ...okSets(['sv03.5', 'base1']), '/sets/sv03.5': () => json(fx('sv03.5')), '/sets/base1': () => json(fx('base1')) });
    const r = await fetchAllCards(f.fn, silentLog, noSleep);
    expect(r.skippedSets).toEqual([]);
    expect(f.calls.every((c) => c.startsWith('https://api.tcgdex.net/v2/en/'))).toBe(true);
    expect(r.cards).toContainEqual({
      id: 'sv03.5-199', name: 'Charizard ex', number: '199', setId: 'sv03.5', setName: '151', setPrintedTotal: 165,
    });
    expect(r.cards).toContainEqual({
      id: 'base1-4', name: 'Charizard', number: '4', setId: 'base1', setName: 'Base Set', setPrintedTotal: 102,
    });
  });

  it('normalizes localId like the matcher: strips zero padding, uppercases alphanumerics', async () => {
    const f = fakeFetch({
      ...okSets(['sv03.5', 'swsh12tg']), '/sets/sv03.5': () => json(fx('sv03.5')), '/sets/swsh12tg': () => json(fx('swsh12tg')),
    });
    const r = await fetchAllCards(f.fn, silentLog, noSleep);
    const num = (id: string) => r.cards.find((c) => c.id === id)?.number;
    expect(num('sv03.5-001')).toBe('1');
    expect(num('sv03.5-006')).toBe('6');
    expect(num('swsh12tg-TG30')).toBe('TG30');
  });

  it('retries 429 and 5xx with backoff, then succeeds', async () => {
    const delays: number[] = [];
    const f = fakeFetch({
      ...okSets(['base1']),
      '/sets/base1': (_u, n) => (n === 1 ? json({}, 429) : n === 2 ? json({}, 503) : json(fx('base1'))),
    });
    const r = await fetchAllCards(f.fn, silentLog, { sleep: async (ms) => void delays.push(ms) });
    expect(r.cards).toHaveLength(1);
    expect(f.calls.filter((c) => c.endsWith('/sets/base1'))).toHaveLength(3);
    expect(delays).toHaveLength(2);
    expect(delays[1]!).toBeGreaterThan(delays[0]!);
  });

  it('skips a set that still fails after 4 tries and reports it', async () => {
    const logs: string[] = [];
    const f = fakeFetch({
      ...okSets(['base1', 'sv03.5']), '/sets/base1': () => json({}, 500), '/sets/sv03.5': () => json(fx('sv03.5')),
    });
    const r = await fetchAllCards(f.fn, (_l, m) => void logs.push(m), noSleep);
    expect(f.calls.filter((c) => c.endsWith('/sets/base1'))).toHaveLength(4);
    expect(r.skippedSets).toEqual(['base1']);
    expect(r.cards.map((c) => c.setId)).toEqual(['sv03.5', 'sv03.5', 'sv03.5']);
    expect(logs.some((m) => m.includes('skip'))).toBe(true);
  });

  it('does not retry a 404', async () => {
    const f = fakeFetch({ ...okSets(['base1']), '/sets/base1': () => json({}, 404) });
    const r = await fetchAllCards(f.fn, silentLog, noSleep);
    expect(f.calls.filter((c) => c.endsWith('/sets/base1'))).toHaveLength(1);
    expect(r.skippedSets).toEqual(['base1']);
  });

  it('runs at most 4 set requests concurrently', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const base = fx('base1') as { id: string };
    const h: Record<string, Handler> = { '/sets': () => json(ids.map((id) => ({ id, name: id, cardCount: { total: 1, official: 1 } }))) };
    for (const id of ids) h[`/sets/${id}`] = () => json({ ...base, id });
    const f = fakeFetch(h);
    await fetchAllCards(f.fn, silentLog, noSleep);
    expect(f.maxInFlight()).toBe(4);
  });

  it('throws when the set list itself fails', async () => {
    const f = fakeFetch({ '/sets': () => json({}, 500) });
    await expect(fetchAllCards(f.fn, silentLog, noSleep)).rejects.toThrow(/sets/);
  });

  it('excludes digital TCG Pocket (tcgp) sets without fetching them and logs the count', async () => {
    const logs: { m: string; c?: Record<string, unknown> }[] = [];
    const sets = [...(fx('sets') as { id: string }[]).filter((s) => s.id === 'base1'), { id: 'A1', name: 'Genetic Apex' }, { id: 'P-A', name: 'Promo-A' }];
    const f = fakeFetch({
      '/sets': () => json(sets),
      '/series/tcgp': () => json({ id: 'tcgp', sets: [{ id: 'A1' }, { id: 'P-A' }] }),
      '/sets/base1': () => json(fx('base1')),
    });
    const r = await fetchAllCards(f.fn, (_l, m, c) => void logs.push({ m, c }), noSleep);
    expect(r.cards.map((c) => c.setId)).toEqual(['base1']);
    expect(r.skippedSets).toEqual([]);
    expect(f.calls.some((c) => c.endsWith('/sets/A1') || c.endsWith('/sets/P-A'))).toBe(false);
    expect(logs.find((l) => l.m.includes('excluded'))?.c).toMatchObject({ excluded: 2 });
  });

  it('also drops a set whose detail says it belongs to an excluded series', async () => {
    const f = fakeFetch({
      '/sets': () => json([{ id: 'A9', name: 'Future Pocket' }]),
      '/sets/A9': () => json({ id: 'A9', name: 'Future Pocket', serie: { id: 'tcgp' }, cardCount: { official: 1 }, cards: [{ id: 'A9-001', localId: '001', name: 'X' }] }),
    });
    const r = await fetchAllCards(f.fn, silentLog, noSleep);
    expect(r.cards).toEqual([]);
    expect(r.skippedSets).toEqual([]);
  });

  it('passes a timeout abort signal on every request', async () => {
    const f = fakeFetch({ ...okSets(['base1']), '/sets/base1': () => json(fx('base1')) });
    await fetchAllCards(f.fn, silentLog, noSleep);
    expect(f.inits.length).toBeGreaterThan(0);
    expect(f.inits.every((i) => i?.signal instanceof AbortSignal)).toBe(true);
  });

  it('treats a timeout as retryable', async () => {
    let n = 0;
    const f = fakeFetch({
      ...okSets(['base1']),
      '/sets/base1': () => {
        if (++n === 1) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        return json(fx('base1'));
      },
    });
    const r = await fetchAllCards(f.fn, silentLog, noSleep);
    expect(r.cards).toHaveLength(1);
    expect(r.skippedSets).toEqual([]);
  });

  it('honors Retry-After on 429, capped at 30s', async () => {
    const delays: number[] = [];
    const f = fakeFetch({
      ...okSets(['base1']),
      '/sets/base1': (_u, n) =>
        n === 1 ? new Response('{}', { status: 429, headers: { 'Retry-After': '7' } })
        : n === 2 ? new Response('{}', { status: 429, headers: { 'Retry-After': '999' } })
        : json(fx('base1')),
    });
    await fetchAllCards(f.fn, silentLog, { sleep: async (ms) => void delays.push(ms) });
    expect(delays).toEqual([7000, 30000]);
  });

  it('stores a zero official count as null', async () => {
    const f = fakeFetch({
      '/sets': () => json([{ id: 'z' }]),
      '/sets/z': () => json({ id: 'z', name: 'Z', cardCount: { official: 0, total: 3 }, cards: [{ id: 'z-1', localId: '1', name: 'X' }] }),
    });
    const r = await fetchAllCards(f.fn, silentLog, noSleep);
    expect(r.cards[0]!.setPrintedTotal).toBeNull();
  });

  it('reports how many sets it attempted', async () => {
    const f = fakeFetch({ ...okSets(['base1', 'sv03.5']), '/sets/base1': () => json(fx('base1')), '/sets/sv03.5': () => json({}, 404) });
    expect((await fetchAllCards(f.fn, silentLog, noSleep)).attemptedSets).toBe(2);
  });
});
