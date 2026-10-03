import { describe, expect, it } from 'vitest';
import { fixtureCompsSource, loadFixtureCompsSource, type CompsSource } from '../../src/oracle/comps-source.js';
import { getValuation } from '../../src/oracle/oracle.js';
import { ORACLE_VERSION } from '../../src/oracle/valuation.js';
import { DEFAULT_SETTINGS } from '../../src/settings/settings.js';
import { createTestDb } from '../helpers/test-db.js';
import { seedCards } from '../helpers/fixtures.js';

const KEY = { cardId: 'sv03.5-199', grader: 'PSA' as const, grade: 10 };
let now = new Date('2026-10-03T12:00:00Z');
const clock = () => now;

function countingSource(inner: CompsSource): CompsSource & { calls: number } {
  const s = { name: inner.name, calls: 0, fetchComps: async (k: typeof KEY) => { s.calls++; return inner.fetchComps(k); } };
  return s;
}

describe('getValuation', () => {
  it('computes, persists, and caches within max age', async () => {
    now = new Date('2026-10-03T12:00:00Z');
    const db = await createTestDb();
    await seedCards(db);
    const source = countingSource(
      fixtureCompsSource([{ ...KEY, sales: [100, 110, 120, 130].map((price, i) => ({ price, daysAgo: i + 1 })) }], clock),
    );
    const v1 = await getValuation({ db, source, now: clock }, KEY, DEFAULT_SETTINGS);
    expect(v1).toMatchObject({ value: 115, compCount: 4, compsSource: 'fixture' });
    const v2 = await getValuation({ db, source, now: clock }, KEY, DEFAULT_SETTINGS);
    expect(v2?.value).toBe(115);
    expect(source.calls).toBe(1);

    now = new Date('2026-10-04T13:00:00Z');
    await getValuation({ db, source, now: clock }, KEY, DEFAULT_SETTINGS);
    expect(source.calls).toBe(2);
    const { rows } = await db.query<{ n: number }>('select count(*)::int as n from comps');
    expect(rows[0]!.n).toBe(4);
  });

  it('returns null when the source has no comps', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const source = fixtureCompsSource([], clock);
    expect(await getValuation({ db, source, now: clock }, KEY, DEFAULT_SETTINGS)).toBeNull();
  });

  it('loads the repo fixture file', async () => {
    const source = await loadFixtureCompsSource('data/comps-fixture.json', clock);
    expect((await source.fetchComps(KEY)).length).toBeGreaterThan(0);
  });
});

describe('getValuation excludeFixture', () => {
  it('ignores stored fixture comps when excludeFixture is set, keeps other comps', async () => {
    now = new Date('2026-10-03T12:00:00Z');
    const db = await createTestDb();
    await seedCards(db);
    const fixture = fixtureCompsSource([{ ...KEY, sales: [100, 110, 120, 130].map((price, i) => ({ price, daysAgo: i + 1 })) }], clock);
    // Fixture comps were persisted by an earlier fixture-mode run.
    expect(await getValuation({ db, source: fixture, now: clock }, KEY, DEFAULT_SETTINGS)).toMatchObject({ compCount: 4 });
    // The fixture-built cached valuation is not served once excludeFixture is on.
    expect(await getValuation({ db, source: fixtureCompsSource([], clock), now: clock, excludeFixture: true }, KEY, DEFAULT_SETTINGS)).toBeNull();
    await db.query('delete from valuations');

    const empty = fixtureCompsSource([], clock);
    expect(await getValuation({ db, source: empty, now: clock }, KEY, DEFAULT_SETTINGS)).toMatchObject({ compCount: 4 });
    await db.query('delete from valuations');
    expect(await getValuation({ db, source: empty, now: clock, excludeFixture: true }, KEY, DEFAULT_SETTINGS)).toBeNull();

    await db.query(
      `insert into comps (card_id, grader, grade, price, sold_at, kind, source_ref)
       select $1, $2, $3, 500, $4::timestamptz - (g || ' days')::interval, 'paid_source', 'real:' || g from generate_series(1, 3) g`,
      [KEY.cardId, KEY.grader, KEY.grade, now],
    );
    const v = await getValuation({ db, source: empty, now: clock, excludeFixture: true }, KEY, DEFAULT_SETTINGS);
    expect(v).toMatchObject({ compCount: 3, value: 500 });
  });
});

describe('getValuation disappearing-BIN comps', () => {
  const NOW = new Date('2026-10-03T12:00:00Z');
  async function insertComps(db: Awaited<ReturnType<typeof createTestDb>>, kind: string, prices: number[], prefix: string) {
    for (const [i, price] of prices.entries()) {
      await db.query(
        `insert into comps (card_id, grader, grade, price, sold_at, kind, source_ref) values ($1, $2, $3, $4, $5, $6, $7)`,
        [KEY.cardId, KEY.grader, KEY.grade, price, new Date(NOW.getTime() - (i + 1) * 86_400_000), kind, `${prefix}:${i}`],
      );
    }
  }

  it('never values a card from disappearing_bin comps alone, and persists nothing', async () => {
    now = NOW;
    const db = await createTestDb();
    await seedCards(db);
    await insertComps(db, 'disappearing_bin', [900, 900, 900], 'ebay:relist');
    const v = await getValuation({ db, source: fixtureCompsSource([], clock), now: clock }, KEY, DEFAULT_SETTINGS);
    expect(v).toBeNull();
    const { rows } = await db.query('select 1 from valuations');
    expect(rows).toHaveLength(0);
  });

  it('counts disappearing_bin comps when mixed with another comp kind', async () => {
    now = NOW;
    const db = await createTestDb();
    await seedCards(db);
    await insertComps(db, 'paid_source', [100, 120], 'real');
    await insertComps(db, 'disappearing_bin', [110], 'ebay:sold');
    const v = await getValuation({ db, source: fixtureCompsSource([], clock), now: clock }, KEY, DEFAULT_SETTINGS);
    expect(v).toMatchObject({ compCount: 3 });
  });
});

describe('getValuation cache', () => {
  it('only reuses cached valuations computed by the current ORACLE_VERSION', async () => {
    now = new Date('2026-10-03T12:00:00Z');
    const db = await createTestDb();
    await seedCards(db);
    await db.query(
      `insert into valuations (card_id, grader, grade, value, low, high, comp_count, newest_comp_age_days, confidence,
         comps_source, oracle_version, computed_at)
       values ($1, $2, $3, 828, 828, 828, 3, 1, 0.9, 'own_db', 'v1.0.0', $4)`,
      [KEY.cardId, KEY.grader, KEY.grade, new Date(now.getTime() - 3_600_000)],
    );
    expect(await getValuation({ db, source: fixtureCompsSource([], clock), now: clock }, KEY, DEFAULT_SETTINGS)).toBeNull();

    const source = fixtureCompsSource([{ ...KEY, sales: [100, 110, 120, 130].map((price, i) => ({ price, daysAgo: i + 1 })) }], clock);
    const v = await getValuation({ db, source, now: clock }, KEY, DEFAULT_SETTINGS);
    expect(v).toMatchObject({ value: 115, oracleVersion: ORACLE_VERSION });
    const cached = await getValuation({ db, source: fixtureCompsSource([], clock), now: clock }, KEY, DEFAULT_SETTINGS);
    expect(cached?.value).toBe(115);
  });
});

