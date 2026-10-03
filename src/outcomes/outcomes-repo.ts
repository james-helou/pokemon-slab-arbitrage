import type { Db } from '../db/db.js';
import type { Grader } from '../domain/types.js';
import { HORIZONS_DAYS, type OutcomeLabel } from './label.js';

export type ListingFinalState = 'live' | 'sold_out' | 'not_found' | 'gone_unknown';
export type DecisionSnapshot = 'bought' | 'pass' | 'watch' | 'none';
/** 'realized' is reserved for slice 4 (inventory + sales). */
export type LabelBasis = 'counterfactual' | 'realized' | 'no_valuation';

export interface NewOutcome {
  recommendationId: number;
  horizonDays: number;
  listingFinalState: ListingFinalState;
  observedPrice: number | null;
  marketValue: number | null;
  valuationConfidence: number | null;
  valuationCompCount: number | null;
  netAtHorizon: number | null;
  netChannel: string | null;
  label: OutcomeLabel | null;
  labelBasis: LabelBasis;
  decision: DecisionSnapshot;
  minNet: number;
  trackerVersion: string;
  oracleVersion: string | null;
  observedAt: Date;
}

/** Append-only; returns false when this (recommendation, horizon) already has an outcome. */
export async function insertOutcome(db: Db, o: NewOutcome): Promise<boolean> {
  const { rows } = await db.query(
    `insert into outcomes (recommendation_id, horizon_days, listing_final_state, observed_price, market_value_at_horizon,
       valuation_confidence, valuation_comp_count, net_at_horizon, net_channel, label, label_basis, decision, min_net,
       tracker_version, oracle_version, observed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     on conflict (recommendation_id, horizon_days) do nothing
     returning id`,
    [
      o.recommendationId, o.horizonDays, o.listingFinalState, o.observedPrice, o.marketValue, o.valuationConfidence,
      o.valuationCompCount, o.netAtHorizon, o.netChannel, o.label, o.labelBasis, o.decision, o.minNet,
      o.trackerVersion, o.oracleVersion, o.observedAt,
    ],
  );
  return rows.length > 0;
}

export interface DueRecommendation {
  id: number;
  externalId: string;
  cardId: string;
  grader: Grader;
  grade: number;
  buyTotal: number;
  createdAt: Date;
  /** Horizons (days) that have elapsed and have no outcome yet, ascending. */
  horizons: number[];
}

const HORIZON_VALUES = HORIZONS_DAYS.map((h) => `(${h})`).join(', ');

export async function dueOutcomes(db: Db, now: Date, limit: number): Promise<DueRecommendation[]> {
  const { rows } = await db.query<Record<string, unknown>>(
    `select r.id, r.external_id, r.card_id, r.grader, r.grade, r.buy_total, r.created_at,
       array_agg(h.horizon order by h.horizon) as horizons
     from recommendations r
     cross join (values ${HORIZON_VALUES}) as h(horizon)
     where r.created_at + make_interval(days => h.horizon) <= $1::timestamptz
       and not exists (select 1 from outcomes o where o.recommendation_id = r.id and o.horizon_days = h.horizon)
     group by r.id
     order by r.created_at, r.id
     limit $2`,
    [now, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    externalId: String(r.external_id),
    cardId: String(r.card_id),
    grader: r.grader as Grader,
    grade: Number(r.grade),
    buyTotal: Number(r.buy_total),
    createdAt: new Date(r.created_at as string),
    horizons: (r.horizons as unknown[]).map(Number),
  }));
}

/** Strongest human decision so far: bought > pass > watch > none. */
export async function decisionSnapshot(db: Db, recommendationId: number): Promise<DecisionSnapshot> {
  const { rows } = await db.query<{ action: 'bought' | 'pass' | 'watch' }>(
    `select action from decisions where recommendation_id = $1
     order by case action when 'bought' then 3 when 'pass' then 2 else 1 end desc, id desc
     limit 1`,
    [recommendationId],
  );
  return rows[0]?.action ?? 'none';
}
