import { describe, expect, it } from 'vitest';
import { createPoketraceClient, PoketraceHttpError, PoketraceUnavailableError } from '../../src/poketrace/client.js';

const KEY = 'sk-super-secret-key';
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

function harness(
  responses: (() => Response | Promise<Response>)[],
  breaker: { breakerThreshold?: number; breakerCooldownMs?: number } = {},
) {
  let t = 0;
  const sleeps: number[] = [];
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    return r();
  }) as unknown as typeof fetch;
  const client = createPoketraceClient({
    apiKey: KEY, fetch: fetchFn, now: () => t, ...breaker,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
  });
  return { client, calls, sleeps, advance: (ms: number) => { t += ms; } };
}

describe('poketrace client', () => {
  it('sends the API key header, query string, and a timeout signal', async () => {
    const h = harness([() => json({ data: [] })]);
    await h.client.get('/cards', { tcgplayer_ids: '123', search: 'Charizard ex' });
    expect(h.calls[0]!.url).toBe('https://api.poketrace.com/v1/cards?tcgplayer_ids=123&search=Charizard+ex');
    expect((h.calls[0]!.init!.headers as Record<string, string>)['X-API-Key']).toBe(KEY);
    expect(h.calls[0]!.init!.signal).toBeInstanceOf(AbortSignal);
  });

  it('retries 429 honoring Retry-After, then succeeds', async () => {
    const h = harness([() => json({}, 429, { 'Retry-After': '2' }), () => json({ ok: 1 })]);
    expect(await h.client.get('/cards/x')).toEqual({ ok: 1 });
    expect(h.calls).toHaveLength(2);
    expect(h.sleeps).toContain(2000);
  });

  it('retries 5xx with backoff and gives up after 3 tries', async () => {
    const h = harness([() => json({}, 503)]);
    await expect(h.client.get('/cards/x')).rejects.toThrow('503');
    expect(h.calls).toHaveLength(3);
  });

  it('caps Retry-After at 10s', async () => {
    const h = harness([() => json({}, 429, { 'Retry-After': '120' }), () => json({ ok: 1 })]);
    expect(await h.client.get('/cards/x')).toEqual({ ok: 1 });
    expect(h.sleeps).toContain(10_000);
    expect(Math.max(...h.sleeps)).toBe(10_000);
  });

  it('exposes the HTTP status on the error', async () => {
    const h = harness([() => json({}, 404)]);
    const err = await h.client.get('/cards/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PoketraceHttpError);
    expect((err as PoketraceHttpError).status).toBe(404);
  });

  it('does not retry other 4xx', async () => {
    const h = harness([() => json({}, 401)]);
    await expect(h.client.get('/cards/x')).rejects.toThrow('401');
    expect(h.calls).toHaveLength(1);
  });

  it('never leaks the key in errors (status, network, bad body)', async () => {
    for (const r of [
      () => json({ error: KEY }, 500),
      () => { throw new Error(`boom ${KEY}`); },
      () => new Response('not json', { status: 200 }),
    ]) {
      const h = harness([r]);
      const err = await h.client.get('/cards/x').catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect(String((err as Error).message)).not.toContain(KEY);
      expect(String((err as Error).stack)).not.toContain(KEY);
    }
  });

  it('rate limits to at most 3 requests per second', async () => {
    const h = harness([() => json({})]);
    await Promise.all(Array.from({ length: 7 }, () => h.client.get('/cards')));
    // 3 burst tokens, then 4 more need >= 4/3 s of refill
    const waited = h.sleeps.reduce((a, b) => a + b, 0);
    expect(h.calls).toHaveLength(7);
    expect(waited).toBeGreaterThanOrEqual(1300);
  });

  describe('circuit breaker', () => {
    const fail = () => json({}, 503);

    it('opens after 5 consecutive failed requests and then fails fast without calling fetch', async () => {
      const h = harness([fail]);
      for (let i = 0; i < 5; i++) await expect(h.client.get('/cards/x')).rejects.toBeInstanceOf(PoketraceHttpError);
      expect(h.calls).toHaveLength(15);
      const err = await h.client.get('/cards/x').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PoketraceUnavailableError);
      expect(String((err as Error).message)).not.toContain(KEY);
      expect(h.calls).toHaveLength(15);
    });

    it('recovers after the 10 minute cooldown, and one success resets the failure count', async () => {
      let ok = false;
      const h = harness([() => (ok ? json({ ok: 1 }) : fail())]);
      for (let i = 0; i < 5; i++) await h.client.get('/cards/x').catch(() => {});
      h.advance(9 * 60_000);
      await expect(h.client.get('/cards/x')).rejects.toBeInstanceOf(PoketraceUnavailableError);
      h.advance(60_000);
      ok = true;
      expect(await h.client.get('/cards/x')).toEqual({ ok: 1 });
      // Count was reset: 4 more failures do not open it again.
      ok = false;
      for (let i = 0; i < 4; i++) await expect(h.client.get('/cards/x')).rejects.toBeInstanceOf(PoketraceHttpError);
      ok = true;
      expect(await h.client.get('/cards/x')).toEqual({ ok: 1 });
    });

    it('a failure right after the cooldown reopens it (half-open)', async () => {
      const h = harness([fail]);
      for (let i = 0; i < 5; i++) await h.client.get('/cards/x').catch(() => {});
      h.advance(10 * 60_000);
      await expect(h.client.get('/cards/x')).rejects.toBeInstanceOf(PoketraceHttpError);
      const calls = h.calls.length;
      await expect(h.client.get('/cards/x')).rejects.toBeInstanceOf(PoketraceUnavailableError);
      expect(h.calls).toHaveLength(calls);
    });

    it('takes an injected threshold and cooldown', async () => {
      const h = harness([fail], { breakerThreshold: 2, breakerCooldownMs: 1000 });
      for (let i = 0; i < 2; i++) await h.client.get('/cards/x').catch(() => {});
      await expect(h.client.get('/cards/x')).rejects.toBeInstanceOf(PoketraceUnavailableError);
      h.advance(1000);
      await expect(h.client.get('/cards/x')).rejects.toBeInstanceOf(PoketraceHttpError);
    });

    it('a 404 is a healthy answer: it does not count toward opening and resets the count', async () => {
      let status = 503;
      const h = harness([() => json({}, status)]);
      for (let i = 0; i < 4; i++) await h.client.get('/cards/x').catch(() => {});
      status = 404;
      for (let i = 0; i < 5; i++) await expect(h.client.get('/cards/x')).rejects.toBeInstanceOf(PoketraceHttpError);
      status = 503;
      for (let i = 0; i < 4; i++) await expect(h.client.get('/cards/x')).rejects.toBeInstanceOf(PoketraceHttpError);
    });
  });
});
