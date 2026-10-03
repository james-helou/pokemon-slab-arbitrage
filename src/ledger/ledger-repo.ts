import type { Db } from '../db/db.js';
import type { Grader, Valuation } from '../domain/types.js';
import type { ChannelNet } from '../scoring/scorer.js';

export type Route = 'alerts' | 'over_budget';

export interface ListingSnapshot {
  title: string;
  url: string;
  imageUrl: string | null;
  price: number;
  shipping: number;
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
    createdAt: new Date(r.created_at as string),
  };
}

/** Returns the new id, or null when this listing already has a recommendation. */
export async function insertRecommendation(db: Db, r: NewRecommendation): Promise<number | null> {
  const { rows } = await db.query<{ id: number }>(
    `insert into recommendations (source, external_id, card_id, grader, grade, cert, listing_snapshot, card_snapshot,
       valuation_snapshot, channel_nets, best_channel, buy_total, best_net, roi, confidence, rank, red_flags, routed_to,
       scorer_version, matcher_version, oracle_version)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, $14, $15, $16,
       $17::jsonb, $18, $19, $20, $21)
     on conflict (source, external_id) do nothing
     returning id`,
    [
      r.source, r.externalId, r.cardId, r.grader, r.grade, r.cert, JSON.stringify(r.listingSnapshot),
      JSON.stringify(r.cardSnapshot), JSON.stringify(r.valuationSnapshot), JSON.stringify(r.channelNets),
      r.bestChannel, r.buyTotal, r.bestNet, r.roi, r.confidence, r.rank, JSON.stringify(r.redFlags), r.routedTo,
      r.scorerVersion, r.matcherVersion, r.oracleVersion,
    ],
  );
  return rows[0] ? Number(rows[0].id) : null;
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

export async function dueDeliveries(
  db: Db,
  now: Date,
  limit: number,
): Promise<{ recommendation: StoredRecommendation; route: Route }[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `select r.*, d.route from alert_deliveries d join recommendations r on r.id = d.recommendation_id
     where d.status <> 'sent' and d.attempts < 5
       and (d.attempts = 0 or d.updated_at <= $1::timestamptz - make_interval(secs => 30 * power(2, d.attempts)))
     order by r.rank desc limit $2`,
    [now, limit],
  );
  return rows.map((r) => ({ recommendation: rowToRecommendation(r), route: r.route as Route }));
}

export async function markDelivered(db: Db, recommendationId: number, messageId: string, now: Date): Promise<void> {
  await db.query(
    `update alert_deliveries set status = 'sent', message_id = $2, attempts = attempts + 1, updated_at = $3
     where recommendation_id = $1`,
    [recommendationId, messageId, now],
  );
}

export async function markFailed(db: Db, recommendationId: number, error: string, now: Date): Promise<void> {
  await db.query(
    `update alert_deliveries set status = 'failed', last_error = $2, attempts = attempts + 1, updated_at = $3
     where recommendation_id = $1`,
    [recommendationId, error.slice(0, 1000), now],
  );
}

export type DecisionAction = 'bought' | 'pass' | 'watch';

export async function insertDecision(
  db: Db,
  d: { recommendationId: number; action: DecisionAction; reason: string | null; actor: string | null },
): Promise<void> {
  await db.query(`insert into decisions (recommendation_id, action, reason, actor) values ($1, $2, $3, $4)`, [
    d.recommendationId, d.action, d.reason, d.actor,
  ]);
}

export async function hasDecision(db: Db, recommendationId: number, action: DecisionAction): Promise<boolean> {
  const { rows } = await db.query('select 1 from decisions where recommendation_id = $1 and action = $2 limit 1', [
    recommendationId, action,
  ]);
  return rows.length > 0;
}
