import { describe, expect, it } from 'vitest';
import { addEntry, availableCash } from '../../src/bankroll/bankroll-repo.js';
import {
  dueDeliveries, getRecommendation, hasDecision, insertDecision, insertDelivery, insertRecommendation,
  markDelivered, markFailed,
} from '../../src/ledger/ledger-repo.js';
import { insertMatch, markGone, upsertListing } from '../../src/listings/listings-repo.js';
import { mergeItemDetails, summaryToListing } from '../../src/sources/ebay/normalize.js';
import { createTestDb } from '../helpers/test-db.js';
import { ITEM, SUMMARY, makeNewRecommendation, seedCards } from '../helpers/fixtures.js';

const NOW = new Date('2026-10-03T12:00:00Z');

describe('listings repo', () => {
  it('reports new vs seen and keeps enriched aspects', async () => {
    const db = await createTestDb();
    const summary = summaryToListing(SUMMARY)!;
    expect((await upsertListing(db, summary, NOW)).isNew).toBe(true);
    await upsertListing(db, mergeItemDetails(summary, ITEM)!, NOW);
    expect((await upsertListing(db, summary, NOW)).isNew).toBe(false);
    const { rows } = await db.query<{ aspects: Record<string, string> }>('select aspects from listings');
    expect(rows[0]!.aspects['Grade']).toBe('10');
    const nullShip = { ...summary, externalId: 'v1|222|0', shipping: null };
    await upsertListing(db, nullShip, NOW);
    const sh = await db.query<{ shipping: string | null }>(`select shipping from listings where external_id = 'v1|222|0'`);
    expect(sh.rows[0]!.shipping).toBeNull();
    await markGone(db, summary, NOW);
    await insertMatch(db, summary, { match: null, reasons: ['lot'] }, 'title');
    const m = await db.query<{ reasons: string[] }>('select reasons from listing_matches');
    expect(m.rows[0]!.reasons).toEqual(['lot']);
  });
});

describe('ledger repo', () => {
  it('inserts once, round-trips, and dedupes by listing', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const id = await insertRecommendation(db, makeNewRecommendation());
    expect(id).toBeTypeOf('number');
    expect(await insertRecommendation(db, makeNewRecommendation())).toBeNull();
    const rec = await getRecommendation(db, id!);
    expect(rec).toMatchObject({ id, bestNet: 133.75, grade: 10, routedTo: 'alerts' });
    expect(rec?.channelNets[0]?.channel).toBe('ebay');
  });

  it('schedules deliveries with exponential backoff', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const id = (await insertRecommendation(db, makeNewRecommendation()))!;
    await insertDelivery(db, id, 'alerts');
    expect((await dueDeliveries(db, NOW, 10)).map((d) => d.recommendation.id)).toEqual([id]);
    await markFailed(db, id, 'boom', NOW);
    expect(await dueDeliveries(db, new Date(NOW.getTime() + 30_000), 10)).toEqual([]);
    expect(await dueDeliveries(db, new Date(NOW.getTime() + 61_000), 10)).toHaveLength(1);
    await markDelivered(db, id, 'msg-1', NOW);
    expect(await dueDeliveries(db, new Date(NOW.getTime() + 999_000), 10)).toEqual([]);
  });

  it('claims due deliveries so overlapping ticks do not double-send', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const id = (await insertRecommendation(db, makeNewRecommendation()))!;
    await insertDelivery(db, id, 'alerts');
    expect(await dueDeliveries(db, NOW, 10)).toHaveLength(1);
    expect(await dueDeliveries(db, NOW, 10)).toEqual([]);
  });

  it('logs when a delivery is dead after max attempts', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const id = (await insertRecommendation(db, makeNewRecommendation()))!;
    await insertDelivery(db, id, 'alerts');
    const logs: string[] = [];
    const spy = (level: string, msg: string) => void logs.push(`${level}:${msg}`);
    for (let i = 0; i < 5; i++) await markFailed(db, id, 'boom', NOW, spy);
    expect(logs).toEqual(['error:alert delivery dead']);
  });

  it('records decisions', async () => {
    const db = await createTestDb();
    await seedCards(db);
    const id = (await insertRecommendation(db, makeNewRecommendation()))!;
    expect(await hasDecision(db, id, 'bought')).toBe(false);
    expect(await insertDecision(db, { recommendationId: id, action: 'bought', reason: null, actor: 'james' })).toBe(true);
    expect(await hasDecision(db, id, 'bought')).toBe(true);
    expect(await insertDecision(db, { recommendationId: id, action: 'bought', reason: null, actor: 'james' })).toBe(false);
    expect(await insertDecision(db, { recommendationId: id, action: 'pass', reason: null, actor: 'james' })).toBe(true);
  });
});

describe('bankroll repo', () => {
  it('sums the ledger', async () => {
    const db = await createTestDb();
    expect(await availableCash(db)).toBe(0);
    await addEntry(db, { kind: 'deposit', amount: 500 });
    await addEntry(db, { kind: 'purchase', amount: -379.85 });
    expect(await availableCash(db)).toBe(120.15);
  });
});
