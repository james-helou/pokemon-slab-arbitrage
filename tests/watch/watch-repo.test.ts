import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/db.js';
import {
  dueForFinalCheck, endedUnfinalized, finalize, markAlerted, setMatch, upsertSeen, type SeenAuction,
} from '../../src/watch/watch-repo.js';
import { seedCards } from '../helpers/fixtures.js';
import { createTestDb } from '../helpers/test-db.js';

const NOW = new Date('2026-10-28T12:00:00Z');
const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
const seen = (o: Partial<SeenAuction> = {}): SeenAuction => ({
  source: 'ebay', externalId: 'v1|1|0', title: 'PSA 10 Charizard ex 199/165', url: 'https://www.ebay.com/itm/1',
  imageUrl: 'https://i.ebayimg.com/1.jpg', endsAt: at(60), currentBid: 3000, bidCount: 5, ...o,
});
const key = (externalId = 'v1|1|0') => ({ source: 'ebay', externalId });
const MATCH = { cardId: 'sv03.5-199', grader: 'PSA' as const, grade: 10 };

async function db(): Promise<Db> {
  const d = await createTestDb();
  await seedCards(d);
  return d;
}
const comps = (d: Db) => d.query<{ price: string; kind: string; source_ref: string; sold_at: Date; grade: string }>(
  'select price, kind, source_ref, sold_at, grade from comps order by source_ref',
);

describe('watch repo', () => {
  it('upserts: a second sighting updates the bid and keeps first_seen_at', async () => {
    const d = await db();
    const first = await upsertSeen(d, seen(), NOW);
    expect(first).toMatchObject({
      source: 'ebay', externalId: 'v1|1|0', currentBid: 3000, bidCount: 5, endsAt: at(60), firstSeenAt: NOW,
      lastSeenAt: NOW, matchStatus: null, cardId: null, grade: null, alertedBid: null, realertedAt: null, endedAt: null,
    });
    const second = await upsertSeen(d, seen({ currentBid: 3500.5, bidCount: 7, title: 'new title', endsAt: at(61) }), at(15));
    expect(second).toMatchObject({ currentBid: 3500.5, bidCount: 7, title: 'new title', endsAt: at(61), firstSeenAt: NOW, lastSeenAt: at(15) });
    expect(typeof second.currentBid).toBe('number');
  });

  it('records a match or the reason there is none', async () => {
    const d = await db();
    await upsertSeen(d, seen(), NOW);
    await upsertSeen(d, seen({ externalId: 'v1|2|0' }), NOW);
    await setMatch(d, key(), MATCH);
    await setMatch(d, key('v1|2|0'), { status: 'no_match:no_number' });
    const rows = await d.query<{ external_id: string; match_status: string; card_id: string | null; grade: string | null }>(
      'select external_id, match_status, card_id, grade from watch_auctions order by external_id',
    );
    expect(rows.rows.map((r) => ({ ...r, grade: r.grade === null ? null : Number(r.grade) }))).toEqual([
      { external_id: 'v1|1|0', match_status: 'ok', card_id: 'sv03.5-199', grade: 10 },
      { external_id: 'v1|2|0', match_status: 'no_match:no_number', card_id: null, grade: null },
    ]);
  });

  it('marks the alert, then the re-alert, without touching the first', async () => {
    const d = await db();
    await upsertSeen(d, seen(), NOW);
    const sources = [{ name: 'ppt', value: 2000, saleCount: 5, asOf: NOW }];
    await markAlerted(d, key(), { bid: 3000, value: 2000, sources, now: NOW, realert: false });
    await markAlerted(d, key(), { bid: 3750, value: 2100, sources, now: at(30), realert: true });
    const r = (await upsertSeen(d, seen({ currentBid: 3750 }), at(31)));
    expect(r).toMatchObject({
      alertedAt: NOW, alertedBid: 3000, valueAtAlert: 2000, realertedAt: at(30), realertedBid: 3750,
    });
    expect(r.sourcesAtAlert).toEqual([{ name: 'ppt', value: 2000, saleCount: 5, asOf: NOW.toISOString() }]);
  });

  it('finds matched open auctions in their last minutes, and ended unfinalized ones', async () => {
    const d = await db();
    await upsertSeen(d, seen({ externalId: 'soon', endsAt: at(5) }), NOW);
    await upsertSeen(d, seen({ externalId: 'later', endsAt: at(30) }), NOW);
    await upsertSeen(d, seen({ externalId: 'soon_unmatched', endsAt: at(5) }), NOW);
    await upsertSeen(d, seen({ externalId: 'ended', endsAt: at(-1) }), NOW);
    await upsertSeen(d, seen({ externalId: 'ended_done', endsAt: at(-2) }), NOW);
    for (const id of ['soon', 'later', 'ended', 'ended_done']) await setMatch(d, key(id), MATCH);
    await finalize(d, key('ended_done'), { finalBid: 1, finalBidCount: 1, endedAt: at(-2) });
    expect((await dueForFinalCheck(d, NOW, 10)).map((r) => r.externalId)).toEqual(['soon']);
    expect((await endedUnfinalized(d, NOW)).map((r) => r.externalId)).toEqual(['ended']);
  });

  it('finalize writes one auction_result comp for a matched 2+ bid auction, idempotently', async () => {
    const d = await db();
    await upsertSeen(d, seen({ externalId: 'm2', endsAt: at(-1) }), NOW);
    await upsertSeen(d, seen({ externalId: 'm1', endsAt: at(-1) }), NOW);
    await upsertSeen(d, seen({ externalId: 'u2', endsAt: at(-1) }), NOW);
    await setMatch(d, key('m2'), MATCH);
    await setMatch(d, key('m1'), MATCH);
    await setMatch(d, key('u2'), { status: 'low_confidence' });
    await finalize(d, key('m2'), { finalBid: 3100, finalBidCount: 2, endedAt: at(-1) });
    await finalize(d, key('m2'), { finalBid: 3100, finalBidCount: 2, endedAt: at(-1) });
    await finalize(d, key('m1'), { finalBid: 3100, finalBidCount: 1, endedAt: at(-1) });
    await finalize(d, key('u2'), { finalBid: 3100, finalBidCount: 5, endedAt: at(-1) });
    const c = (await comps(d)).rows;
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ kind: 'auction_result', source_ref: 'ebay_auction:m2', sold_at: at(-1) });
    expect(Number(c[0]!.price)).toBe(3100);
    expect(Number(c[0]!.grade)).toBe(10);
    const row = (await d.query<{ final_bid: string; final_bid_count: number; ended_at: Date }>(
      `select final_bid, final_bid_count, ended_at from watch_auctions where external_id = 'm2'`,
    )).rows[0]!;
    expect([Number(row.final_bid), row.final_bid_count, row.ended_at]).toEqual([3100, 2, at(-1)]);
  });
});
