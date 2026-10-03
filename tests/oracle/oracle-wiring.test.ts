import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import type { CompsSource } from '../../src/oracle/comps-source.js';
import { buildOracleDeps } from '../../src/oracle/oracle-wiring.js';
import { createTestDb } from '../helpers/test-db.js';
import { seedCards } from '../helpers/fixtures.js';

const ENV = {
  DATABASE_URL: 'postgres://u:p@h:5432/d', EBAY_CLIENT_ID: 'a', EBAY_CLIENT_SECRET: 'b', DISCORD_TOKEN: 't',
  DISCORD_APP_ID: '1', DISCORD_GUILD_ID: '2', DISCORD_ALERT_CHANNEL_ID: '3', DISCORD_OVERBUDGET_CHANNEL_ID: '4',
};
const KEY = { cardId: 'sv03.5-199', grader: 'PSA' as const, grade: 10 };
const now = () => new Date('2026-10-03T12:00:00Z');

async function harness() {
  const db = await createTestDb();
  await seedCards(db);
  const lines: { msg: string; data?: Record<string, unknown> }[] = [];
  const fetched: { url: string; headers?: Record<string, string> }[] = [];
  const fixtureLoads: string[] = [];
  const fixture: CompsSource = { name: 'fixture', fetchComps: async () => [] };
  const deps = {
    db, now,
    log: (_l: string, msg: string, data?: Record<string, unknown>) => { lines.push({ msg, data }); },
    fetch: (async (url: string, init?: RequestInit) => {
      fetched.push({ url, headers: init?.headers as Record<string, string> | undefined });
      return new Response('{}', { status: 500 });
    }) as unknown as typeof fetch,
    loadFixture: async (path: string) => { fixtureLoads.push(path); return fixture; },
  };
  return { deps, lines, fetched, fixtureLoads };
}

describe('buildOracleDeps', () => {
  it('fixture mode: fixture + own DB comps, no aggregate, fixture comps not excluded', async () => {
    const h = await harness();
    const o = await buildOracleDeps(loadConfig(ENV), h.deps);
    expect(o.source.name).toBe('fixture+own_db');
    expect(o.aggregate).toBeUndefined();
    expect(o.excludeFixture).toBe(false);
    expect(h.fixtureLoads).toEqual(['data/comps-fixture.json']);
    expect(h.lines.map((l) => l.msg)).toEqual(['comps source: fixture']);
  });

  it('poketrace mode: aggregate + own DB comps only, fixture excluded and never loaded', async () => {
    const h = await harness();
    const o = await buildOracleDeps(loadConfig({ ...ENV, COMPS_SOURCE: 'poketrace', POKETRACE_API_KEY: 'pt-s3cret' }), h.deps);
    expect(o.source.name).toBe('own_db');
    expect(o.aggregate).toBeDefined();
    expect(o.excludeFixture).toBe(true);
    expect(h.fixtureLoads).toEqual([]);
    expect(h.lines.map((l) => l.msg)).toEqual(['comps source: poketrace']);
  });

  it('poketrace mode wires mapping through the injected fetch and log (a mapping failure falls back)', async () => {
    const h = await harness();
    const o = await buildOracleDeps(loadConfig({ ...ENV, COMPS_SOURCE: 'poketrace', POKETRACE_API_KEY: 'pt-s3cret' }), h.deps);
    expect(await o.aggregate!.fetchAggregate(KEY)).toBeNull();
    expect(h.fetched.map((f) => f.url)).toEqual(['https://api.tcgdex.net/v2/en/cards/sv03.5-199']);
    expect(h.lines.map((l) => l.msg)).toContain('poketrace mapping failed');
    expect(JSON.stringify(h.lines)).not.toContain('pt-s3cret');
  });
});
