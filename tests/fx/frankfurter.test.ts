import { describe, expect, it } from 'vitest';
import { createUsdCadRate } from '../../src/fx/frankfurter.js';

const T0 = new Date('2026-10-09T12:00:00Z');

function setup(respond: () => Response | Promise<Response>) {
  const urls: string[] = [];
  const logs: string[] = [];
  let t = T0.getTime();
  const fetch = (async (url: string) => { urls.push(url); return respond(); }) as unknown as typeof globalThis.fetch;
  const rate = createUsdCadRate({ fetch, now: () => new Date(t), log: (_l, m) => { logs.push(m); } });
  return { rate, urls, logs, advance: (ms: number) => { t += ms; } };
}
const ok = (cad: unknown) => () => new Response(JSON.stringify({ base: 'USD', rates: { CAD: cad } }), { status: 200 });

describe('createUsdCadRate', () => {
  it('fetches the USD to CAD rate', async () => {
    const { rate, urls } = setup(ok(1.4226));
    expect(await rate()).toBe(1.4226);
    expect(urls).toEqual(['https://api.frankfurter.dev/v1/latest?base=USD&symbols=CAD']);
  });

  it('returns null on a non-2xx and logs one warn', async () => {
    const { rate, logs } = setup(() => new Response('nope', { status: 503 }));
    expect(await rate()).toBeNull();
    expect(logs).toHaveLength(1);
  });

  it.each([[0.5], [2.5], ['1.4'], [null], [Number.NaN]])('returns null for a bad value %s', async (v) => {
    const { rate } = setup(ok(v));
    expect(await rate()).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    const { rate } = setup(() => { throw new Error('network down'); });
    expect(await rate()).toBeNull();
  });

  it('caches within the ttl and refetches after it', async () => {
    const { rate, urls, advance } = setup(ok(1.4));
    await rate();
    advance(11 * 3_600_000);
    expect(await rate()).toBe(1.4);
    expect(urls).toHaveLength(1);
    advance(2 * 3_600_000);
    await rate();
    expect(urls).toHaveLength(2);
  });

  it('after a failure returns null for 10 minutes without refetching or logging, then retries', async () => {
    let n = 0;
    const { rate, urls, logs, advance } = setup(() => (n++ === 0 ? new Response('x', { status: 500 }) : ok(1.41)()));
    expect(await rate()).toBeNull();
    advance(9 * 60_000);
    expect(await rate()).toBeNull();
    expect(urls).toHaveLength(1);
    expect(logs).toHaveLength(1);
    advance(61_000);
    expect(await rate()).toBe(1.41);
    expect(urls).toHaveLength(2);
  });
});
