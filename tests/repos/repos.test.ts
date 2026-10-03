import { describe, expect, it } from 'vitest';
import { addEntry, availableCash } from '../../src/bankroll/bankroll-repo.js';
import {
  dueDeliveries, getRecommendation, hasDecision, insertDecision, insertDelivery, insertRecommendation,
  markDelivered, markFailed,
} from '../../src/ledger/ledger-repo.js';
import {
  insertMatch, markGone, markSeenLive, recordWindowMisses, upsertListing,
} from '../../src/listings/listings-repo.js';
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

describe('disappearance bookkeeping', () => {
  const at = (iso: string, id: string) => ({ ...summaryToListing(SUMMARY)!, externalId: id, listedAt: new Date(iso) });
  const missOf = async (db: Awaited<ReturnType<typeof createTestDb>>, id: string) =>
    (await db.query<{ miss_count: number }>('select miss_count from listings where external_id = $1', [id])).rows[0]!.miss_count;

  it('counts window misses only inside the window and resets on sighting', async () => {
    const db = await createTestDb();
    await upsertListing(db, at('2026-10-03T11:50:00Z', 'A'), NOW);
    await upsertListing(db, at('2026-10-03T11:55:00Z', 'B'), NOW);
    await upsertListing(db, at('2026-10-03T11:58:00Z', 'C'), NOW);
    const floor = new Date('2026-10-03T11:52:00Z'); // A is older than the window, C was returned, B is missing
    expect(await recordWindowMisses(db, 'ebay', ['C'], floor)).toBe(1);
    expect(await recordWindowMisses(db, 'ebay', ['C'], floor)).toBe(1);
    expect(await missOf(db, 'B')).toBe(2);
    expect(await missOf(db, 'A')).toBe(0);
    expect(await missOf(db, 'C')).toBe(0);
    await upsertListing(db, at('2026-10-03T11:55:00Z', 'B'), NOW);
    expect(await missOf(db, 'B')).toBe(0);
  });

  it('records why a listing is gone and revives unconfirmed window misses', async () => {
    const db = await createTestDb();
    const l = at('2026-10-03T11:55:00Z', 'B');
    await upsertListing(db, l, NOW);
    const row = async () =>
      (await db.query<{ gone_at: Date | null; gone_reason: string | null }>('select gone_at, gone_reason from listings')).rows[0]!;
    await markGone(db, l, NOW, 'window_miss');
    expect((await row()).gone_reason).toBe('window_miss');
    await upsertListing(db, l, NOW); // seen again: the miss was a false positive
    expect(await row()).toEqual({ gone_at: null, gone_reason: null });
    await markGone(db, l, NOW, 'window_miss');
    await markGone(db, l, NOW, 'not_found'); // a confirmation upgrades window_miss
    expect((await row()).gone_reason).toBe('not_found');
    await markGone(db, l, NOW, 'out_of_stock'); // a confirmed reason is never overwritten
    expect((await row()).gone_reason).toBe('not_found');
    await upsertListing(db, l, NOW); // confirmed gone stays gone
    expect((await row()).gone_reason).toBe('not_found');
  });

  it('markSeenLive clears misses and an unconfirmed gone state', async () => {
    const db = await createTestDb();
    const l = at('2026-10-03T11:55:00Z', 'B');
    await upsertListing(db, l, NOW);
    await db.query('update listings set miss_count = 3');
    await markGone(db, l, NOW, 'window_miss');
    const later = new Date('2026-10-03T13:00:00Z');
    await markSeenLive(db, l, later);
    const { rows } = await db.query<{ miss_count: number; gone_at: Date | null; gone_reason: string | null; checked_at: Date }>(
      'select miss_count, gone_at, gone_reason, checked_at from listings',
    );
    expect(rows[0]).toMatchObject({ miss_count: 0, gone_at: null, gone_reason: null });
    expect(new Date(rows[0]!.checked_at).toISOString()).toBe(later.toISOString());
  });

  it('ignores gone listings and listings exactly at the floor', async () => {
    const db = await createTestDb();
    await upsertListing(db, at('2026-10-03T11:55:00Z', 'gone'), NOW);
    await upsertListing(db, at('2026-10-03T11:52:00Z', 'edge'), NOW);
    await upsertListing(db, at('2026-10-03T11:58:00Z', 'open'), NOW);
    await markGone(db, at('2026-10-03T11:55:00Z', 'gone'), NOW, 'not_found');
    const floor = new Date('2026-10-03T11:52:00Z');
    expect(await recordWindowMisses(db, 'ebay', [], floor)).toBe(1); // only 'open'
    expect(await missOf(db, 'gone')).toBe(0);
    expect(await missOf(db, 'edge')).toBe(0);
    expect(await missOf(db, 'open')).toBe(1);
  });
});
