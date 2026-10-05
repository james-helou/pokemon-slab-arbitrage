import type { Db } from '../db/db.js';
import { log as defaultLog, type Log } from '../log.js';
import type { Grader, Valuation } from '../domain/types.js';
import type { ChannelNet } from '../scoring/scorer.js';
import type { SoldCheckSnapshot } from '../soldcheck/sold-check.js';

export const MAX_DELIVERY_ATTEMPTS = 5;
const CLAIM_LEASE_SECS = 300;

export type Route = 'alerts' | 'over_budget';

export interface ListingSnapshot {
  title: string;
  url: string;
  imageUrl: string | null;
  price: number;
  shipping: number | null;
  sellerUsername: string | null;
  sellerFeedbackScore: number | null;
}

export interface CardSnapshot {
  name: string;
  setName: string;
  number: string;
}

export type ValuationSnapshot = Omit<Valuation, 'computedAt'> & { computedAt: string };

export interface NewRecommendation {
  source: 'ebay';
  externalId: string;
  cardId: string;
  grader: Grader;
  grade: number;
  cert: string | null;
  listingSnapshot: ListingSnapshot;
  cardSnapshot: CardSnapshot;
  valuationSnapshot: ValuationSnapshot;
  channelNets: ChannelNet[];
  bestChannel: string;
  buyTotal: number;
  bestNet: number;
  roi: number;
  confidence: number;
  rank: number;
  redFlags: string[];
  routedTo: Route;
  scorerVersion: string;
  matcherVersion: string;
  oracleVersion: string;
  /** Present only when the sold check ran (SOLD_CHECK=on); stored in recommendations.sold_check. */
  soldCheck?: SoldCheckSnapshot;
}

export interface StoredRecommendation extends NewRecommendation {
  id: number;
  createdAt: Date;
}

function rowToRecommendation(r: Record<string, unknown>): StoredRecommendation {
  return {
    id: Number(r.id),
    source: 'ebay',
    externalId: String(r.external_id),
    cardId: String(r.card_id),
    grader: r.grader as Grader,
    grade: Number(r.grade),
    cert: (r.cert as string | null) ?? null,
    listingSnapshot: r.listing_snapshot as ListingSnapshot,
    cardSnapshot: r.card_snapshot as CardSnapshot,
    valuationSnapshot: r.valuation_snapshot as ValuationSnapshot,
    channelNets: r.channel_nets as ChannelNet[],
    bestChannel: String(r.best_channel),
    buyTotal: Number(r.buy_total),
    bestNet: Number(r.best_net),
    roi: Number(r.roi),
    confidence: Number(r.confidence),
    rank: Number(r.rank),
    redFlags: r.red_flags as string[],
    routedTo: r.routed_to as Route,
    scorerVersion: String(r.scorer_version),
    matcherVersion: String(r.matcher_version),
    oracleVersion: String(r.oracle_version),
    ...(r.sold_check ? { soldCheck: r.sold_check as SoldCheckSnapshot } : {}),
    createdAt: new Date(r.created_at as string),
  };
}

/** Returns the new id, or null when this listing already has a recommendation. */
export async function insertRecommendation(db: Db, r: NewRecommendation): Promise<number | null> {
  const { rows } = await db.query<{ id: number }>(
    `insert into recommendations (source, external_id, card_id, grader, grade, cert, listing_snapshot, card_snapshot,
       valuation_snapshot, channel_nets, best_channel, buy_total, best_net, roi, confidence, rank, red_flags, routed_to,
       scorer_version, matcher_version, oracle_version, sold_check)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15, $16,
       $17::jsonb, $18, $19, $20, $21, $22::jsonb)
     on conflict (source, external_id) do nothing
     returning id`,
    [
      r.source, r.externalId, r.cardId, r.grader, r.grade, r.cert, JSON.stringify(r.listingSnapshot),
      JSON.stringify(r.cardSnapshot), JSON.stringify(r.valuationSnapshot), JSON.stringify(r.channelNets),
      r.bestChannel, r.buyTotal, r.bestNet, r.roi, r.confidence, r.rank, JSON.stringify(r.redFlags), r.routedTo,
      r.scorerVersion, r.matcherVersion, r.oracleVersion, r.soldCheck ? JSON.stringify(r.soldCheck) : null,
    ],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

export async function recommendationExists(db: Db, source: 'ebay', externalId: string): Promise<boolean> {
  const { rows } = await db.query('select 1 from recommendations where source = $1 and external_id = $2 limit 1', [
    source, externalId,
  ]);
  return rows.length > 0;
}

export async function getRecommendation(db: Db, id: number): Promise<StoredRecommendation | null> {
  const { rows } = await db.query<Record<string, unknown>>('select * from recommendations where id = $1', [id]);
  return rows[0] ? rowToRecommendation(rows[0]) : null;
}

export async function insertDelivery(db: Db, recommendationId: number, route: Route): Promise<void> {
  await db.query(`insert into alert_deliveries (recommendation_id, route) values ($1, $2) on conflict do nothing`, [
    recommendationId, route,
  ]);
}

/** Marks unsent deliveries whose recommendation is older than maxAgeMinutes as 'expired'. Returns how many. */
export async function expireStaleDeliveries(db: Db, now: Date, maxAgeMinutes: number): Promise<number> {
  const { rows } = await db.query(
    `update alert_deliveries d set status = 'expired', updated_at = $1::timestamptz, next_attempt_at = null
     from recommendations r
     where r.id = d.recommendation_id and d.status <> 'sent' and d.status <> 'expired'
       and r.created_at < $1::timestamptz - make_interval(mins => $2)
     returning d.recommendation_id`,
    [now, maxAgeMinutes],
  );
  return rows.length;
}

/**
 * Atomically claims due deliveries by leasing them (next_attempt_at pushed into the future),
 * so overlapping ticks never receive the same row. markDelivered/markFailed reset the schedule.
 */
export async function dueDeliveries(
  db: Db,
  now: Date,
  limit: number,
): Promise<{ recommendation: StoredRecommendation; route: Route }[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `with claimed as (
       update alert_deliveries set next_attempt_at = $1::timestamptz + make_interval(secs => $4)
       where recommendation_id in (
         select d.recommendation_id from alert_deliveries d join recommendations r on r.id = d.recommendation_id
         where d.status not in ('sent', 'expired') and d.attempts < $3
           and (d.next_attempt_at is null or d.next_attempt_at <= $1::timestamptz)
         order by r.rank desc limit $2
         for update of d skip locked
       )
       returning recommendation_id, route
     )
     select r.*, c.route from claimed c join recommendations r on r.id = c.recommendation_id order by r.rank desc`,
    [now, limit, MAX_DELIVERY_ATTEMPTS, CLAIM_LEASE_SECS],
  );
  return rows.map((r) => ({ recommendation: rowToRecommendation(r), route: r.route as Route }));
}

export async function markDelivered(db: Db, recommendationId: number, messageId: string, now: Date): Promise<void> {
  await db.query(
    `update alert_deliveries set status = 'sent', message_id = $2, attempts = attempts + 1, updated_at = $3,
       next_attempt_at = null where recommendation_id = $1`,
    [recommendationId, messageId, now],
  );
}

export async function markFailed(
  db: Db,
  recommendationId: number,
  error: string,
  now: Date,
  log: Log = defaultLog,
): Promise<void> {
  const { rows } = await db.query<{ attempts: number }>(
    `update alert_deliveries set status = 'failed', last_error = $2, attempts = attempts + 1, updated_at = $3,
       next_attempt_at = $3::timestamptz + make_interval(secs => 30 * power(2, attempts + 1))
     where recommendation_id = $1 returning attempts`,
    [recommendationId, error.slice(0, 1000), now],
  );
  if (rows[0] && Number(rows[0].attempts) >= MAX_DELIVERY_ATTEMPTS) {
    log('error', 'alert delivery dead', { recommendationId, attempts: Number(rows[0].attempts), lastError: error.slice(0, 200) });
  }
}

export type DecisionAction = 'bought' | 'pass' | 'watch';

export async function insertDecision(
  db: Db,
  d: { recommendationId: number; action: DecisionAction; reason: string | null; actor: string | null },
): Promise<boolean> {
  const { rows } = await db.query(
    `insert into decisions (recommendation_id, action, reason, actor) values ($1, $2, $3, $4)
     on conflict do nothing returning id`,
    [d.recommendationId, d.action, d.reason, d.actor],
  );
  return rows.length > 0;
}

export async function hasDecision(db: Db, recommendationId: number, action: DecisionAction): Promise<boolean> {
  const { rows } = await db.query('select 1 from decisions where recommendation_id = $1 and action = $2 limit 1', [
    recommendationId, action,
  ]);
  return rows.length > 0;
}
