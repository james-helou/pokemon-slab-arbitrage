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

const NO_STATS: Partial<NewSoldCheck> = { saleCount: 0, median: null, low: null, high: null, newestSoldAt: null, matchedTitles: [] };
/** An ok row whose low/high bracket the given median. */
const stats = (median: number) => ({ median, low: median - 10, high: median + 10 });

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

  it.each<[string, Partial<NewSoldCheck>]>([
    ['negative sale_count', { saleCount: -1 }],
    ['zero median', { median: 0, low: 0, high: 0 }],
    ['negative low', { low: -1 }],
    ['zero high', { high: 0, median: 0.5, low: 0.25 }],
    ['low above median', { low: 620, median: 610.5, high: 640.25 }],
    ['median above high', { low: 590, median: 650, high: 640.25 }],
    ['unknown grader', { grader: 'XYZ' as never }],
    ['blocked with a median', { status: 'blocked', saleCount: 0, median: 600, low: null, high: null }],
    ['no_results with a low', { status: 'no_results', saleCount: 0, median: null, low: 590, high: null }],
    ['error with a high', { status: 'error', saleCount: 0, median: null, low: null, high: 640 }],
  ])('rejects a row with %s', async (_label, over) => {
    const db = await createTestDb();
    await expect(insertSoldCheck(db, check(over))).rejects.toThrow(/check constraint|violates/i);
  });

  it('accepts every allowed grader, partial ok stats, and null-stat non-ok rows', async () => {
    const db = await createTestDb();
    for (const grader of ['PSA', 'CGC', 'BGS', 'SGC', 'TAG'] as const) await insertSoldCheck(db, check({ grader }));
    await insertSoldCheck(db, check({ median: 600, low: null, high: null }));
    await insertSoldCheck(db, check({ median: 600, low: 600, high: 600 }));
    for (const status of ['no_results', 'blocked', 'error'] as const) await insertSoldCheck(db, check({ status, ...NO_STATS }));
    expect(await countSoldChecksSince(db, T0)).toBe(10);
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
    await insertSoldCheck(db, check({ status: 'blocked', ...NO_STATS }));
    expect(await latestOkSoldCheck(db, key, 12, T0)).toBeNull();
  });

  it('returns the newest ok row within the age window for the same key only', async () => {
    const db = await createTestDb();
    await insertSoldCheck(db, check({ fetchedAt: new Date(T0.getTime() - 20 * HOUR), ...stats(500) }));
    await insertSoldCheck(db, check({ fetchedAt: new Date(T0.getTime() - 2 * HOUR), ...stats(600) }));
    await insertSoldCheck(db, check({ fetchedAt: new Date(T0.getTime() - 1 * HOUR), status: 'error', ...NO_STATS }));
    await insertSoldCheck(db, check({ grade: 9, fetchedAt: T0, ...stats(100) }));
    await insertSoldCheck(db, check({ grader: 'CGC', fetchedAt: T0, ...stats(101) }));
    await insertSoldCheck(db, check({ cardId: 'sv01-1', fetchedAt: T0, ...stats(102) }));
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
    await insertSoldCheck(db, check({ fetchedAt: new Date(T0.getTime() - 1 * HOUR), status: 'blocked', ...NO_STATS }));
    await insertSoldCheck(db, check({ fetchedAt: T0, status: 'no_results', grade: 9, ...NO_STATS }));
    expect(await countSoldChecksSince(db, new Date(T0.getTime() - 12 * HOUR))).toBe(2);
    expect(await countSoldChecksSince(db, new Date(T0.getTime() + 1))).toBe(0);
  });
});
