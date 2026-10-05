import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { challengeResponse, createAccountDeletionHandler } from '../../src/http/account-deletion.js';
import { startHttpServer } from '../../src/http/server.js';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789_-AB';
const ENDPOINT = 'https://slab-bot.example.com/ebay/account-deletion';

describe('challengeResponse', () => {
  it('is sha256(code + token + endpoint) as lowercase hex', () => {
    const expected = createHash('sha256').update('code123' + TOKEN + ENDPOINT).digest('hex');
    expect(challengeResponse('code123', TOKEN, ENDPOINT)).toBe(expected);
  });
  it('matches a hard-coded vector', () => {
    expect(challengeResponse('abc', 'def', 'ghi')).toBe(
      '19cc02f26df43cc571bc9ed7b0c4d29224a3ec229529221725ef76d021c8326f',
    );
  });
});

describe('account deletion server', () => {
  const closers: Array<() => Promise<void>> = [];
  const lines: Array<{ msg: string; data?: Record<string, unknown> }> = [];
  afterEach(async () => {
    while (closers.length) await closers.pop()!();
    lines.length = 0;
  });

  async function start(): Promise<string> {
    const log = (_l: string, msg: string, data?: Record<string, unknown>) => { lines.push({ msg, ...(data ? { data } : {}) }); };
    const handler = createAccountDeletionHandler({
      endpoint: ENDPOINT, verificationToken: TOKEN, path: new URL(ENDPOINT).pathname, log,
    });
    const s = await startHttpServer({ port: 0, handler, log });
    closers.push(() => s.close());
    return `http://127.0.0.1:${s.port}`;
  }

  it('answers the challenge', async () => {
    const base = await start();
    const r = await fetch(`${base}/ebay/account-deletion?challenge_code=xyz`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    expect(await r.json()).toEqual({ challengeResponse: challengeResponse('xyz', TOKEN, ENDPOINT) });
  });

  it('400s a GET without challenge_code', async () => {
    const base = await start();
    expect((await fetch(`${base}/ebay/account-deletion`)).status).toBe(400);
  });

  it('204s a valid notification and logs only id and topic', async () => {
    const base = await start();
    const body = {
      metadata: { topic: 'MARKETPLACE_ACCOUNT_DELETION', schemaVersion: '1.0' },
      notification: {
        notificationId: 'notif-123', eventDate: '2026-01-01T00:00:00Z',
        data: { username: 'sellerbob', userId: 'uid-999', eiasToken: 'eias-secret' },
      },
    };
    const r = await fetch(`${base}/ebay/account-deletion`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-ebay-signature': 'sig' }, body: JSON.stringify(body),
    });
    expect(r.status).toBe(204);
    expect(await r.text()).toBe('');
    const logged = JSON.stringify(lines);
    expect(logged).toContain('notif-123');
    expect(logged).toContain('MARKETPLACE_ACCOUNT_DELETION');
    for (const s of ['sellerbob', 'uid-999', 'eias-secret']) expect(logged).not.toContain(s);
  });

  it('400s malformed JSON', async () => {
    const base = await start();
    const r = await fetch(`${base}/ebay/account-deletion`, { method: 'POST', body: '{nope' });
    expect(r.status).toBe(400);
  });

  it('413s bodies over 64 KB', async () => {
    const base = await start();
    const r = await fetch(`${base}/ebay/account-deletion`, { method: 'POST', body: 'x'.repeat(65 * 1024) });
    expect(r.status).toBe(413);
  });

  it('405s other methods, 404s other paths, 200s /healthz', async () => {
    const base = await start();
    expect((await fetch(`${base}/ebay/account-deletion`, { method: 'PUT' })).status).toBe(405);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    const h = await fetch(`${base}/healthz`);
    expect(h.status).toBe(200);
    expect(await h.text()).toBe('ok');
  });
});

describe('config: eBay deletion vars', () => {
  const ENV = {
    DATABASE_URL: 'postgres://u:p@h:5432/d', EBAY_CLIENT_ID: 'a', EBAY_CLIENT_SECRET: 'b', DISCORD_TOKEN: 't',
    DISCORD_APP_ID: '1', DISCORD_GUILD_ID: '2', DISCORD_ALERT_CHANNEL_ID: '3', DISCORD_OVERBUDGET_CHANNEL_ID: '4',
  };
  const msg = (env: Record<string, string>) => {
    try { loadConfig({ ...ENV, ...env }); } catch (e) { return e instanceof Error ? e.message : String(e); }
    return '';
  };

  it('accepts both unset or blank, and PORT', () => {
    expect(loadConfig(ENV).EBAY_DELETION_ENDPOINT).toBeUndefined();
    const c = loadConfig({ ...ENV, EBAY_DELETION_ENDPOINT: '', EBAY_DELETION_VERIFICATION_TOKEN: '', PORT: '' });
    expect(c.EBAY_DELETION_VERIFICATION_TOKEN).toBeUndefined();
    expect(c.PORT).toBeUndefined();
    expect(loadConfig({ ...ENV, PORT: '3000' }).PORT).toBe(3000);
  });
  it('accepts both set', () => {
    const c = loadConfig({ ...ENV, EBAY_DELETION_ENDPOINT: ENDPOINT, EBAY_DELETION_VERIFICATION_TOKEN: TOKEN });
    expect(c.EBAY_DELETION_ENDPOINT).toBe(ENDPOINT);
  });
  it('names the missing var when only one is set', () => {
    expect(msg({ EBAY_DELETION_ENDPOINT: ENDPOINT })).toMatch(/EBAY_DELETION_VERIFICATION_TOKEN/);
    const m = msg({ EBAY_DELETION_VERIFICATION_TOKEN: TOKEN });
    expect(m).toMatch(/EBAY_DELETION_ENDPOINT/);
    expect(m).not.toContain(TOKEN);
  });
  it('rejects http endpoints', () => {
    expect(msg({ EBAY_DELETION_ENDPOINT: 'http://x.example.com/a', EBAY_DELETION_VERIFICATION_TOKEN: TOKEN }))
      .toMatch(/EBAY_DELETION_ENDPOINT/);
  });
  it('rejects short or badly-charactered tokens without echoing them', () => {
    const short = 'shorttoken';
    const m1 = msg({ EBAY_DELETION_ENDPOINT: ENDPOINT, EBAY_DELETION_VERIFICATION_TOKEN: short });
    expect(m1).toMatch(/EBAY_DELETION_VERIFICATION_TOKEN/);
    expect(m1).not.toContain(short);
    const bad = 'bad token with spaces and symbols!!!!!!!!!';
    const m2 = msg({ EBAY_DELETION_ENDPOINT: ENDPOINT, EBAY_DELETION_VERIFICATION_TOKEN: bad });
    expect(m2).toMatch(/EBAY_DELETION_VERIFICATION_TOKEN/);
    expect(m2).not.toContain(bad);
  });
});
