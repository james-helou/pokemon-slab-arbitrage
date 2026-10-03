import { describe, expect, it } from 'vitest';
import { findCandidates, getCard } from '../../src/catalog/catalog-repo.js';
import { syncCatalog } from '../../src/catalog/sync.js';
import { silentLog } from '../../src/log.js';
import { createTestDb } from '../helpers/test-db.js';
import { seedCards } from '../helpers/fixtures.js';

function fakeFetch(pages: unknown[][]): typeof fetch {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    return new Response(JSON.stringify({ data: pages[page - 1], page, pageSize: 2, totalCount: 3 }));
  }) as unknown as typeof fetch;
  return Object.assign(fn, { calls });
}

const card = (id: string, name: string, number: string, total: number) => ({
  id, name, number, set: { id: id.split('-')[0], name: 'Set ' + id.split('-')[0], printedTotal: total },
});

describe('catalog', () => {
  it('syncs all pages and upserts', async () => {
    const db = await createTestDb();
    const fetchFn = fakeFetch([
      [card('a-1', 'Pikachu', '1', 100), card('a-2', 'Raichu', '2', 100)],
      [card('b-1', 'Pikachu', '1', 50)],
    ]);
    expect(await syncCatalog(db, fetchFn, undefined, silentLog)).toBe(3);
    expect(await syncCatalog(db, fetchFn, undefined, silentLog)).toBe(3);
    const { rows } = await db.query<{ n: number }>('select count(*)::int as n from cards');
    expect(rows[0]!.n).toBe(3);
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
});
