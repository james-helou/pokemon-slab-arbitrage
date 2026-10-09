import { describe, expect, it } from 'vitest';
import { createPptClient, PptHttpError, PptUnavailableError } from '../../src/ppt/client.js';

const KEY = 'ppt-super-secret-key';
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

function harness(responses: (() => Response | Promise<Response>)[]) {
  let t = 0;
  const sleeps: number[] = [];
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return responses[Math.min(calls.length - 1, responses.length - 1)]!();
  }) as unknown as typeof fetch;
  const client = createPptClient({
    apiKey: KEY, fetch: fetchFn, now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
  });
  return { client, calls, sleeps, advance: (ms: number) => { t += ms; } };
}

describe('ppt client', () => {
  it('sends Bearer auth, the query string, and a timeout signal', async () => {
    const h = harness([() => json({ data: [] })]);
    await h.client.get('/cards', { tcgPlayerId: '123', includeEbay: 'true' });
    expect(h.calls[0]!.url).toBe('https://www.pokemonpricetracker.com/api/v2/cards?tcgPlayerId=123&includeEbay=true');
    expect((h.calls[0]!.init!.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${KEY}`);
    expect(h.calls[0]!.init!.signal).toBeInstanceOf(AbortSignal);
  });

  it('retries 429 honoring Retry-After (capped at 10s), then succeeds', async () => {
    const h = harness([() => json({}, 429, { 'Retry-After': '120' }), () => json({ ok: 1 })]);
    expect(await h.client.get('/cards')).toEqual({ ok: 1 });
    expect(h.sleeps).toContain(10_000);
  });

  it('retries 5xx and gives up after 3 tries; 404 is not retried and carries its status', async () => {
    const h = harness([() => json({}, 503)]);
    await expect(h.client.get('/cards')).rejects.toThrow('503');
    expect(h.calls).toHaveLength(3);
    const h2 = harness([() => json({}, 404)]);
    const err = await h2.client.get('/cards').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PptHttpError);
    expect((err as PptHttpError).status).toBe(404);
    expect(h2.calls).toHaveLength(1);
  });

  it('never leaks the key in errors', async () => {
    for (const r of [
      () => json({ error: KEY }, 500),
      () => { throw new Error(`boom ${KEY}`); },
      () => new Response('not json', { status: 200 }),
    ]) {
      const h = harness([r]);
      const err = await h.client.get('/cards').catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect(String((err as Error).message)).not.toContain(KEY);
      expect(String((err as Error).stack)).not.toContain(KEY);
    }
  });

  it('rate limits to 1 request per second', async () => {
    const h = harness([() => json({})]);
    await Promise.all(Array.from({ length: 4 }, () => h.client.get('/cards')));
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2900);
  });

  it('opens the breaker after 5 failed requests, then fails fast, and recovers after the cooldown', async () => {
    const h = harness([() => json({}, 503)]);
    for (let i = 0; i < 5; i++) await expect(h.client.get('/cards')).rejects.toBeInstanceOf(PptHttpError);
    expect(h.calls).toHaveLength(15);
    await expect(h.client.get('/cards')).rejects.toBeInstanceOf(PptUnavailableError);
    expect(h.calls).toHaveLength(15);
    h.advance(10 * 60_000);
    await expect(h.client.get('/cards')).rejects.toBeInstanceOf(PptHttpError);
    expect(h.calls).toHaveLength(18);
  });
});
