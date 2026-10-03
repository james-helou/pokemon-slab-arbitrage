import { describe, expect, it } from 'vitest';
import { createPoketraceClient } from '../../src/poketrace/client.js';

const KEY = 'sk-super-secret-key';
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

function harness(responses: (() => Response | Promise<Response>)[]) {
  let t = 0;
  const sleeps: number[] = [];
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    return r();
  }) as unknown as typeof fetch;
  const client = createPoketraceClient({
    apiKey: KEY, fetch: fetchFn, now: () => t,
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

  it('retries 5xx with backoff and gives up after 4 tries', async () => {
    const h = harness([() => json({}, 503)]);
    await expect(h.client.get('/cards/x')).rejects.toThrow('503');
    expect(h.calls).toHaveLength(4);
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
});
