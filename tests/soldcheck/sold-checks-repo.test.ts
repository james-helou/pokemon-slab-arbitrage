import { describe, expect, it } from 'vitest';
import { getRecommendation, insertRecommendation } from '../../src/ledger/ledger-repo.js';
import {
  countSoldChecksSince, insertSoldCheck, latestOkSoldCheck, type NewSoldCheck,
} from '../../src/soldcheck/sold-checks-repo.js';
import { createTestDb } from '../helpers/test-db.js';
import { makeNewRecommendation, seedCards } from '../helpers/fixtures.js';

const HOUR = 3_600_000;
const T0 = new Date('2026-10-04T12:00:00.000Z');
const key = { cardId: 'sv03.5-199', grader: 'PSA' as const, grade: 10 };

const check = (over: Partial<NewSoldCheck> = {}): NewSoldCheck => ({
  ...key, query: 'Charizard ex 199 PSA 10', status: 'ok', fetchedAt: T0, saleCount: 6, median: 610.5, low: 590,
  high: 640.25, newestSoldAt: new Date('2026-10-02T00:00:00.000Z'), matchedTitles: ['PSA 10 Charizard ex 199/165'],
  parserVersion: 'v0-unverified', ...over,
});

describe('sold_checks migration', () => {
  it('is append-only', async () => {
    const db = await createTestDb();
    await insertSoldCheck(db, check());
    await expect(db.query(`update sold_checks set median = 1`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from sold_checks`)).rejects.toThrow(/append-only/);
  });

  it('rejects unknown statuses', async () => {
    const db = await createTestDb();
    await expect(insertSoldCheck(db, check({ status: 'weird' as never }))).rejects.toThrow();
  });

  it('adds a nullable sold_check column to recommendations', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const id = (await insertRecommendation(db, makeNewRecommendation()))!;
    expect(await getRecommendation(db, id)).not.toBeNull();
    const { rows } = await db.query<{ sold_check: unknown }>(`select sold_check from recommendations where id = $1`, [id]);
    expect(rows[0]!.sold_check).toBeNull();
  });
});

describe('sold checks repo', () => {
  it('round-trips an ok row with numeric coercion', async () => {
    const db = await createTestDb();
    const id = await insertSoldCheck(db, check());
    expect(id).toBeGreaterThan(0);
    const got = await latestOkSoldCheck(db, key, 12, new Date(T0.getTime() + HOUR));
    expect(got).toMatchObject({
      id, ...key, status: 'ok', saleCount: 6, median: 610.5, low: 590, high: 640.25,
      matchedTitles: ['PSA 10 Charizard ex 199/165'], parserVersion: 'v0-unverified',
    });
    expect(typeof got!.median).toBe('number');
    expect(got!.fetchedAt.toISOString()).toBe(T0.toISOString());
    expect(got!.newestSoldAt!.toISOString()).toBe('2026-10-02T00:00:00.000Z');
  });

  it('stores null stats for non-ok rows', async () => {
    const db = await createTestDb();
    await insertSoldCheck(db, check({ status: 'blocked', saleCount: 0, median: null, low: null, high: null, newestSoldAt: null, matchedTitles: [] }));
    expect(await latestOkSoldCheck(db, key, 12, T0)).toBeNull();
  });

  it('returns the newest ok row within the age window for the same key only', async () => {
    const db = await createTestDb();
    await insertSoldCheck(db, check({ fetchedAt: new Date(T0.getTime() - 20 * HOUR), median: 500 }));
    await insertSoldCheck(db, check({ fetchedAt: new Date(T0.getTime() - 2 * HOUR), median: 600 }));
    await insertSoldCheck(db, check({ fetchedAt: new Date(T0.getTime() - 1 * HOUR), status: 'error', median: null }));
    await insertSoldCheck(db, check({ grade: 9, fetchedAt: T0, median: 100 }));
    await insertSoldCheck(db, check({ grader: 'CGC', fetchedAt: T0, median: 101 }));
    await insertSoldCheck(db, check({ cardId: 'sv01-1', fetchedAt: T0, median: 102 }));
    expect((await latestOkSoldCheck(db, key, 12, T0))!.median).toBe(600);
    expect(await latestOkSoldCheck(db, key, 1, T0)).toBeNull();
    expect((await latestOkSoldCheck(db, key, 24, T0))!.median).toBe(600);
  });

  it('caps matched titles at 30 short entries', async () => {
    const db = await createTestDb();
    await insertSoldCheck(db, check({ matchedTitles: Array.from({ length: 50 }, (_, i) => `${i} ${'x'.repeat(500)}`) }));
    const got = (await latestOkSoldCheck(db, key, 12, T0))!;
    expect(got.matchedTitles).toHaveLength(30);
    for (const t of got.matchedTitles) expect(t.length).toBeLessThanOrEqual(120);
  });

  it('counts every fetch since a time regardless of status or key', async () => {
    const db = await createTestDb();
    await insertSoldCheck(db, check({ fetchedAt: new Date(T0.getTime() - 13 * HOUR) }));
    await insertSoldCheck(db, check({ fetchedAt: new Date(T0.getTime() - 1 * HOUR), status: 'blocked' }));
    await insertSoldCheck(db, check({ fetchedAt: T0, status: 'no_results', grade: 9 }));
    expect(await countSoldChecksSince(db, new Date(T0.getTime() - 12 * HOUR))).toBe(2);
    expect(await countSoldChecksSince(db, new Date(T0.getTime() + 1))).toBe(0);
  });
});
