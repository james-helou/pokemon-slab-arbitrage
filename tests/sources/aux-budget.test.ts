import { describe, expect, it } from 'vitest';
import { AUX_SOURCE, claimAuxCall } from '../../src/sources/ebay/aux-budget.js';
import type { Budget } from '../../src/sources/ebay/budget.js';
import { createTestDb } from '../helpers/test-db.js';

const NOW = () => new Date('2026-10-03T12:00:00Z');
const main = (used: number): Budget => ({ limit: 5000, beforeCall: async () => {}, usedToday: async () => used });
const auxCalls = async (db: Awaited<ReturnType<typeof createTestDb>>) =>
  (await db.query<{ calls: number }>('select calls from api_usage where source = $1', [AUX_SOURCE])).rows[0]?.calls ?? 0;

describe('claimAuxCall', () => {
  it('allows calls up to the daily cap, then refuses', async () => {
    const db = await createTestDb();
    expect(await claimAuxCall(db, main(0), 2, NOW)).toBe(true);
    expect(await claimAuxCall(db, main(0), 2, NOW)).toBe(true);
    expect(await claimAuxCall(db, main(0), 2, NOW)).toBe(false);
    expect(Number(await auxCalls(db))).toBe(2);
  });

  it('refuses once scanning has used 80% of the main budget', async () => {
    const db = await createTestDb();
    expect(await claimAuxCall(db, main(4000), 300, NOW)).toBe(false);
    expect(Number(await auxCalls(db))).toBe(0);
  });

  it('refuses everything when the cap is 0', async () => {
    const db = await createTestDb();
    expect(await claimAuxCall(db, main(0), 0, NOW)).toBe(false);
  });
});
