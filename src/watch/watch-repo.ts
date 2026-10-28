import type { Db } from '../db/db.js';
import type { Grader } from '../domain/types.js';
import type { SourceValue } from './market-value.js';

export interface WatchKey { source: string; externalId: string }

export interface SeenAuction extends WatchKey {
  title: string;
  url: string;
  imageUrl: string | null;
  endsAt: Date;
  currentBid: number;
  bidCount: number;
}

export interface WatchRow extends SeenAuction {
  cardId: string | null;
  grader: Grader | null;
  grade: number | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** null = not matched yet; 'ok' = matched; otherwise the reason it never will be. */
  matchStatus: string | null;
  valueAtAlert: number | null;
  /** The sources as stored (jsonb): asOf comes back as an ISO string. */
  sourcesAtAlert: unknown;
  alertedAt: Date | null;
  alertedBid: number | null;
  realertedAt: Date | null;
  realertedBid: number | null;
  finalBid: number | null;
  finalBidCount: number | null;
  endedAt: Date | null;
}

interface RawRow {
  source: string; external_id: string; card_id: string | null; grader: Grader | null; grade: string | number | null;
  title: string; url: string; image_url: string | null; first_seen_at: Date | string; last_seen_at: Date | string;
  ends_at: Date | string; current_bid: string | number; bid_count: number; match_status: string | null;
  value_at_alert: string | number | null; sources_at_alert: unknown; alerted_at: Date | string | null;
  alerted_bid: string | number | null; realerted_at: Date | string | null; realerted_bid: string | number | null;
  final_bid: string | number | null; final_bid_count: number | null; ended_at: Date | string | null;
}

const num = (v: string | number | null): number | null => (v === null ? null : Number(v));
const date = (v: Date | string | null): Date | null => (v === null ? null : new Date(v));

function toRow(r: RawRow): WatchRow {
  return {
    source: r.source, externalId: r.external_id, cardId: r.card_id, grader: r.grader, grade: num(r.grade),
    title: r.title, url: r.url, imageUrl: r.image_url, firstSeenAt: new Date(r.first_seen_at),
    lastSeenAt: new Date(r.last_seen_at), endsAt: new Date(r.ends_at), currentBid: Number(r.current_bid),
    bidCount: Number(r.bid_count), matchStatus: r.match_status, valueAtAlert: num(r.value_at_alert),
    sourcesAtAlert: r.sources_at_alert, alertedAt: date(r.alerted_at), alertedBid: num(r.alerted_bid),
    realertedAt: date(r.realerted_at), realertedBid: num(r.realerted_bid), finalBid: num(r.final_bid),
    finalBidCount: num(r.final_bid_count), endedAt: date(r.ended_at),
  };
}

/** Insert a sighting, or refresh the bid, end time and listing text of a known auction. */
export async function upsertSeen(db: Db, a: SeenAuction, now: Date): Promise<WatchRow> {
  const { rows } = await db.query<RawRow>(
    `insert into watch_auctions (source, external_id, title, url, image_url, ends_at, current_bid, bid_count,
       first_seen_at, last_seen_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     on conflict (source, external_id) do update set
       current_bid = excluded.current_bid, bid_count = excluded.bid_count, ends_at = excluded.ends_at,
       last_seen_at = excluded.last_seen_at, title = excluded.title, image_url = excluded.image_url
     returning *`,
    [a.source, a.externalId, a.title, a.url, a.imageUrl, a.endsAt, a.currentBid, a.bidCount, now],
  );
  return toRow(rows[0]!);
}

/** 'ok' with the matched card, or the reason the auction will never match. */
export async function setMatch(
  db: Db,
  k: WatchKey,
  m: { cardId: string; grader: Grader; grade: number } | { status: string },
): Promise<void> {
  if ('status' in m) {
    await db.query(
      `update watch_auctions set match_status = $3, card_id = null, grader = null, grade = null
       where source = $1 and external_id = $2`,
      [k.source, k.externalId, m.status],
    );
    return;
  }
  await db.query(
    `update watch_auctions set match_status = 'ok', card_id = $3, grader = $4, grade = $5
     where source = $1 and external_id = $2`,
    [k.source, k.externalId, m.cardId, m.grader, m.grade],
  );
}

/** First alert stores the bid, value and sources; a re-alert stores only its own bid and time. */
export async function markAlerted(
  db: Db,
  k: WatchKey,
  a: { bid: number; value: number; sources: SourceValue[]; now: Date; realert: boolean },
): Promise<void> {
  if (a.realert) {
    await db.query(
      `update watch_auctions set realerted_at = $3, realerted_bid = $4 where source = $1 and external_id = $2`,
      [k.source, k.externalId, a.now, a.bid],
    );
    return;
  }
  await db.query(
    `update watch_auctions set alerted_at = $3, alerted_bid = $4, value_at_alert = $5, sources_at_alert = $6::jsonb
     where source = $1 and external_id = $2`,
    [k.source, k.externalId, a.now, a.bid, a.value, JSON.stringify(a.sources)],
  );
}

/** Matched open auctions ending within the next `minutes` (not yet ended). */
export async function dueForFinalCheck(db: Db, now: Date, minutes: number): Promise<WatchRow[]> {
  const { rows } = await db.query<RawRow>(
    `select * from watch_auctions
     where ended_at is null and match_status = 'ok' and ends_at > $1 and ends_at <= $2
     order by ends_at, external_id`,
    [now, new Date(now.getTime() + minutes * 60_000)],
  );
  return rows.map(toRow);
}

/** Auctions past their end time that have no result recorded yet. */
export async function endedUnfinalized(db: Db, now: Date): Promise<WatchRow[]> {
  const { rows } = await db.query<RawRow>(
    `select * from watch_auctions where ended_at is null and ends_at <= $1 order by ends_at, external_id`,
    [now],
  );
  return rows.map(toRow);
}

/** Record the result; a matched auction with 2+ bids also becomes an auction_result comp (once). */
export async function finalize(
  db: Db,
  k: WatchKey,
  f: { finalBid: number; finalBidCount: number; endedAt: Date },
): Promise<void> {
  await db.query(
    `update watch_auctions set final_bid = $3, final_bid_count = $4, ended_at = $5
     where source = $1 and external_id = $2`,
    [k.source, k.externalId, f.finalBid, f.finalBidCount, f.endedAt],
  );
  await db.query(
    `insert into comps (card_id, grader, grade, price, sold_at, kind, source_ref)
     select card_id, grader, grade, final_bid, ended_at, 'auction_result', 'ebay_auction:' || external_id
     from watch_auctions
     where source = $1 and external_id = $2 and match_status = 'ok' and final_bid_count >= 2
     on conflict (kind, source_ref) do nothing`,
    [k.source, k.externalId],
  );
}
