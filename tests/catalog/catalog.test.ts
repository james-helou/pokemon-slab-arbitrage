import { describe, expect, it } from 'vitest';
import { findCandidates, getCard } from '../../src/catalog/catalog-repo.js';
import { syncCatalog } from '../../src/catalog/sync.js';
import { matchListing } from '../../src/matcher/matcher.js';
import { silentLog } from '../../src/log.js';
import { createTestDb } from '../helpers/test-db.js';
import { seedCards } from '../helpers/fixtures.js';

function fakeFetch(): typeof fetch {
  const sets: Record<string, unknown> = {
    a: { id: 'a', name: 'Set a', cardCount: { official: 100, total: 110 }, cards: [{ id: 'a-001', localId: '001', name: 'Pikachu' }, { id: 'a-002', localId: '002', name: 'Raichu' }] },
    b: { id: 'b', name: 'Set b', cardCount: { official: 50, total: 50 }, cards: [{ id: 'b-1', localId: '1', name: 'Pikachu' }] },
    tg: { id: 'tg', name: 'Trainer Gallery', cardCount: { official: 30, total: 30 }, cards: [{ id: 'tg-TG30', localId: 'TG30', name: 'Duraludon VMAX' }] },
    c: { id: 'c', name: 'Set c', cardCount: { official: 9, total: 9 }, cards: [] },
  };
  return (async (url: string) => {
    const path = url.replace('https://api.tcgdex.net/v2/en', '');
    if (path === '/sets') return new Response(JSON.stringify(Object.keys(sets).map((id) => ({ id }))));
    const set = sets[path.replace('/sets/', '')];
    return set ? new Response(JSON.stringify(set)) : new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('catalog', () => {
  it('syncs all sets and upserts idempotently, reporting skipped sets', async () => {
    const db = await createTestDb();
    const fetchFn = fakeFetch();
    const r = await syncCatalog(db, fetchFn, silentLog, { sleep: async () => {} });
    expect(r.cards).toBe(4);
    expect(r.skippedSets).toEqual([]);
    expect((await syncCatalog(db, fetchFn, silentLog, { sleep: async () => {} })).cards).toBe(4);
    const { rows } = await db.query<{ n: number }>('select count(*)::int as n from cards');
    expect(rows[0]!.n).toBe(4);
    expect((await getCard(db, 'a-001'))?.number).toBe('1');
  });

  it('matches zero-padded and alphanumeric TCGdex numbers like a listing would', async () => {
    const db = await createTestDb();
    await syncCatalog(db, fakeFetch(), silentLog, { sleep: async () => {} });
    expect((await findCandidates(db, '1', '100')).map((c) => c.id)).toEqual(['a-001']);
  });

  it('finds candidates by number and numeric printed total', async () => {
    const db = await createTestDb();
    await seedCards(db, [
      { id: 'a-1', name: 'Pikachu', number: '1', setId: 'a', setName: 'A', setPrintedTotal: 100 },
      { id: 'b-1', name: 'Pikachu', number: '1', setId: 'b', setName: 'B', setPrintedTotal: 50 },
      { id: 'c-tg05', name: 'Pikachu', number: 'TG05', setId: 'c', setName: 'C', setPrintedTotal: 189 },
    ]);
    expect((await findCandidates(db, '1', '100')).map((c) => c.id)).toEqual(['a-1']);
    expect((await findCandidates(db, '1', null)).map((c) => c.id).sort()).toEqual(['a-1', 'b-1']);
    expect((await findCandidates(db, 'tg05', 'TG30')).map((c) => c.id)).toEqual(['c-tg05']);
    expect((await getCard(db, 'a-1'))?.setName).toBe('A');
    expect(await getCard(db, 'nope')).toBeNull();
  });

  it('matches a zero-padded catalog number against "1/100" and "001/100" listings', async () => {
    const db = await createTestDb();
    await syncCatalog(db, fakeFetch(), silentLog, { sleep: async () => {} });
    for (const title of ['PSA 10 Pikachu 1/100', 'PSA 10 Pikachu 001/100']) {
      const r = await matchListing({ title, aspects: {} }, (n, t) => findCandidates(db, n, t));
      expect(r.match?.cardId).toBe('a-001');
    }
  });

  it('matches an alphanumeric catalog number (TG30)', async () => {
    const db = await createTestDb();
    await syncCatalog(db, fakeFetch(), silentLog, { sleep: async () => {} });
    const r = await matchListing({ title: 'PSA 10 Duraludon VMAX TG30/TG30', aspects: {} }, (n, t) => findCandidates(db, n, t));
    expect(r.match?.cardId).toBe('tg-TG30');
  });
});
