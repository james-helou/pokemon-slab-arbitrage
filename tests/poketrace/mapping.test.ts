import { describe, expect, it } from 'vitest';
import { resolvePoketraceId } from '../../src/poketrace/mapping.js';
import type { PoketraceClient } from '../../src/poketrace/client.js';
import { createTestDb } from '../helpers/test-db.js';
import { seedCards } from '../helpers/fixtures.js';

const UUID = '11111111-2222-3333-4444-555555555555';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const tcgdexCard = (tcgplayer?: number | string) => ({
  id: 'sv03.5-199', localId: '199', name: 'Charizard ex',
  variants_detailed: [{ type: 'holo', thirdParty: tcgplayer === undefined ? {} : { tcgplayer } }],
});
const ptCard = (over: Record<string, unknown> = {}) => ({
  id: UUID, name: 'Charizard ex', cardNumber: '199/165', set: { slug: 'sv-151', name: '151' },
  productType: 'single', refs: { tcgplayerId: '523456' }, ...over,
});

function setup(opts: { tcgdex: () => Response; pt: (path: string, q?: Record<string, string>) => unknown }) {
  const ptCalls: { path: string; q?: Record<string, string> }[] = [];
  const tcgdexCalls: string[] = [];
  const client: PoketraceClient = {
    async get<T>(path: string, q?: Record<string, string>) { ptCalls.push({ path, q }); return opts.pt(path, q) as T; },
  };
  const fetchFn = (async (url: string) => { tcgdexCalls.push(url); return opts.tcgdex(); }) as unknown as typeof fetch;
  return { client, fetchFn, ptCalls, tcgdexCalls };
}

describe('resolvePoketraceId', () => {
  it('maps via the TCGplayer id from TCGdex and caches the result', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const s = setup({ tcgdex: () => json(tcgdexCard(523456)), pt: () => ({ data: [ptCard()] }) });
    const now = () => new Date('2026-10-03T12:00:00Z');
    const deps = { db, client: s.client, fetch: s.fetchFn, now };
    expect(await resolvePoketraceId(deps, 'sv03.5-199')).toBe(UUID);
    expect(s.tcgdexCalls).toEqual(['https://api.tcgdex.net/v2/en/cards/sv03.5-199']);
    expect(s.ptCalls).toEqual([{ path: '/cards', q: { tcgplayer_ids: '523456' } }]);
    expect(await resolvePoketraceId(deps, 'sv03.5-199')).toBe(UUID);
    expect(s.ptCalls).toHaveLength(1);
    expect(s.tcgdexCalls).toHaveLength(1);
  });

  it('returns null when the TCGplayer lookup is ambiguous (several PokeTrace cards)', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const s = setup({ tcgdex: () => json(tcgdexCard(523456)), pt: () => ({ data: [ptCard(), ptCard({ id: 'other' })] }) });
    expect(await resolvePoketraceId({ db, client: s.client, fetch: s.fetchFn, now: () => new Date() }, 'sv03.5-199')).toBeNull();
  });

  describe('fallback search (no TCGplayer id)', () => {
    const run = async (data: unknown[]) => {
      const db = await createTestDb();
      await seedCards(db);
      const s = setup({ tcgdex: () => json(tcgdexCard()), pt: () => ({ data }) });
      const id = await resolvePoketraceId({ db, client: s.client, fetch: s.fetchFn, now: () => new Date() }, 'sv03.5-199');
      return { id, s };
    };

    it('accepts exactly one match on name, number and set name', async () => {
      const { id, s } = await run([ptCard(), ptCard({ id: 'x', cardNumber: '198/165' }), ptCard({ id: 'y', set: { slug: 'z', name: 'Other' } })]);
      expect(id).toBe(UUID);
      expect(s.ptCalls[0]).toEqual({ path: '/cards', q: { search: 'Charizard ex', card_number: '199' } });
    });

    it('returns null on an ambiguous result (two exact matches)', async () => {
      expect((await run([ptCard(), ptCard({ id: 'dup' })])).id).toBeNull();
    });

    it('returns null when nothing matches exactly', async () => {
      expect((await run([ptCard({ name: 'Charizard ex Tera' })])).id).toBeNull();
    });
  });

  it('falls back to search when TCGdex has no such card (404)', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const s = setup({ tcgdex: () => json({}, 404), pt: () => ({ data: [ptCard()] }) });
    expect(await resolvePoketraceId({ db, client: s.client, fetch: s.fetchFn, now: () => new Date() }, 'sv03.5-199')).toBe(UUID);
  });

  it('throws (and caches nothing) when TCGdex errors', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const s = setup({ tcgdex: () => json({}, 500), pt: () => ({ data: [] }) });
    await expect(resolvePoketraceId({ db, client: s.client, fetch: s.fetchFn, now: () => new Date() }, 'sv03.5-199')).rejects.toThrow('500');
    const { rows } = await db.query('select 1 from card_external_ids');
    expect(rows).toHaveLength(0);
  });

  it('negative cache holds for 7 days, then re-resolves', async () => {
    const db = await createTestDb();
    await seedCards(db);
    let found = false;
    const s = setup({ tcgdex: () => json(tcgdexCard(523456)), pt: () => ({ data: found ? [ptCard()] : [] }) });
    let t = new Date('2026-10-03T12:00:00Z');
    const deps = { db, client: s.client, fetch: s.fetchFn, now: () => t };
    expect(await resolvePoketraceId(deps, 'sv03.5-199')).toBeNull();
    found = true;
    t = new Date('2026-10-10T11:00:00Z');
    expect(await resolvePoketraceId(deps, 'sv03.5-199')).toBeNull();
    expect(s.ptCalls).toHaveLength(1);
    t = new Date('2026-10-10T12:00:01Z');
    expect(await resolvePoketraceId(deps, 'sv03.5-199')).toBe(UUID);
    expect(s.ptCalls).toHaveLength(2);
  });

  it('returns null for an unknown card id without calling anything', async () => {
    const db = await createTestDb();
    const s = setup({ tcgdex: () => json({}), pt: () => ({ data: [] }) });
    expect(await resolvePoketraceId({ db, client: s.client, fetch: s.fetchFn, now: () => new Date() }, 'nope')).toBeNull();
    expect(s.tcgdexCalls).toHaveLength(0);
  });
});
