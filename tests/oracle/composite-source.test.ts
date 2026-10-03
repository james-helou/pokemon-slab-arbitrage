import { describe, expect, it } from 'vitest';
import type { CompKind } from '../../src/domain/types.js';
import { silentLog, type Log } from '../../src/log.js';
import { fixtureCompsSource, type CompsSource, type SourcedComp } from '../../src/oracle/comps-source.js';
import { compositeCompsSource } from '../../src/oracle/composite-source.js';
import { getValuation } from '../../src/oracle/oracle.js';
import { ownCompsSource } from '../../src/oracle/own-comps-source.js';
import { DEFAULT_SETTINGS } from '../../src/settings/settings.js';
import { createTestDb } from '../helpers/test-db.js';
import { seedCards } from '../helpers/fixtures.js';

const KEY = { cardId: 'sv03.5-199', grader: 'PSA' as const, grade: 10 };
const NOW = new Date('2026-10-03T12:00:00Z');
const stub = (name: string, comps: SourcedComp[] | Error): CompsSource => ({
  name,
  fetchComps: async () => {
    if (comps instanceof Error) throw comps;
    return comps;
  },
});
const comp = (ref: string, kind: CompKind = 'paid_source'): SourcedComp => ({ price: 100, soldAt: NOW, kind, sourceRef: ref });

describe('compositeCompsSource', () => {
  it('merges parts in order, names them, and dedupes by kind and ref', async () => {
    const s = compositeCompsSource(
      [{ source: stub('a', [comp('x'), comp('y')]) }, { source: stub('b', [comp('y'), comp('y', 'disappearing_bin')]) }],
      silentLog,
    );
    expect(s.name).toBe('a+b');
    expect((await s.fetchComps(KEY)).map((c) => `${c.kind}:${c.sourceRef}`)).toEqual([
      'paid_source:x', 'paid_source:y', 'disappearing_bin:y',
    ]);
  });

  it('fails when a required part fails (never value on partial data)', async () => {
    const s = compositeCompsSource([{ source: stub('vendor', new Error('vendor down')) }, { source: stub('b', []) }], silentLog);
    await expect(s.fetchComps(KEY)).rejects.toThrow('vendor down');
  });

  it('skips and logs an optional part that fails', async () => {
    const logs: string[] = [];
    const log: Log = (_l, msg) => void logs.push(msg);
    const s = compositeCompsSource(
      [{ source: stub('a', [comp('x')]) }, { source: stub('agent', new Error('blocked')), optional: true }],
      log,
    );
    expect(await s.fetchComps(KEY)).toHaveLength(1);
    expect(logs).toContain('optional comps source failed');
  });

  it('rejects an empty part list', () => {
    expect(() => compositeCompsSource([], silentLog)).toThrow();
  });
});

describe('ownCompsSource', () => {
  it('reads only the requested kinds within the window', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const put = (price: number, soldAt: string, kind: CompKind, ref: string) =>
      db.query(
        `insert into comps (card_id, grader, grade, price, sold_at, kind, source_ref) values ('sv03.5-199','PSA',10,$1,$2,$3,$4)`,
        [price, new Date(soldAt), kind, ref],
      );
    await put(300, '2026-10-01T00:00:00Z', 'disappearing_bin', 'ebay:1');
    await put(310, '2026-06-01T00:00:00Z', 'disappearing_bin', 'ebay:old');
    await put(320, '2026-10-01T00:00:00Z', 'paid_source', 'vendor:1');
    const got = await ownCompsSource(db, () => NOW).fetchComps(KEY);
    expect(got).toEqual([{ price: 300, soldAt: new Date('2026-10-01T00:00:00Z'), kind: 'disappearing_bin', sourceRef: 'ebay:1' }]);
  });

  it('combines with the fixture through getValuation', async () => {
    const db = await createTestDb();
    await seedCards(db);
    await db.query(
      `insert into comps (card_id, grader, grade, price, sold_at, kind, source_ref) values ('sv03.5-199','PSA',10,600,$1,'disappearing_bin','ebay:9')`,
      [new Date(NOW.getTime() - 86_400_000)],
    );
    const fixture = fixtureCompsSource([{ ...KEY, sales: [{ price: 600, daysAgo: 1 }, { price: 600, daysAgo: 2 }] }], () => NOW);
    const source = compositeCompsSource([{ source: fixture }, { source: ownCompsSource(db, () => NOW) }], silentLog);
    const v = await getValuation({ db, source, now: () => NOW }, KEY, DEFAULT_SETTINGS);
    expect(v).toMatchObject({ value: 600, compCount: 3, compsSource: 'fixture+own_db' });
  });
});
