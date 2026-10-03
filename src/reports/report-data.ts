import type { Db } from '../db/db.js';
import type { OutcomeLabel } from '../outcomes/label.js';
import { isoWeekRange } from './iso-week.js';
import type { ReportDecision, WeeklyReportInput } from './weekly.js';

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Everything created before the end of `week`, so a past week's report is reproducible. */
export async function loadReportInput(db: Db, week: string, generatedAt: Date, minNet: number): Promise<WeeklyReportInput> {
  const { end } = isoWeekRange(week);
  const recs = await db.query<Record<string, unknown>>(
    `select r.id, r.created_at, r.grader, r.grade, r.buy_total, r.confidence, r.routed_to,
       (r.valuation_snapshot->>'value')::numeric as predicted_value,
       r.valuation_snapshot->>'compsSource' as comps_source, d.status as delivery_status
     from recommendations r left join alert_deliveries d on d.recommendation_id = r.id
     where r.created_at < $1 order by r.id`,
    [end],
  );
  const outs = await db.query<Record<string, unknown>>(
    `select recommendation_id, horizon_days, label, market_value_at_horizon, net_at_horizon, listing_final_state, observed_at
     from outcomes where observed_at < $1 order by id`,
    [end],
  );
  const decs = await db.query<Record<string, unknown>>(
    `select recommendation_id, action, reason, created_at from decisions where created_at < $1 order by id`,
    [end],
  );
  return {
    week,
    generatedAt,
    minNet,
    recommendations: recs.rows.map((r) => ({
      id: Number(r.id),
      createdAt: new Date(r.created_at as string),
      grader: String(r.grader),
      grade: Number(r.grade),
      buyTotal: Number(r.buy_total),
      predictedValue: Number(r.predicted_value),
      confidence: Number(r.confidence),
      routedTo: String(r.routed_to),
      deliveryStatus: (r.delivery_status as string | null | undefined) ?? null,
      compsSource: (r.comps_source as string | null | undefined) ?? null,
    })),
    outcomes: outs.rows.map((o) => ({
      recommendationId: Number(o.recommendation_id),
      horizonDays: Number(o.horizon_days),
      label: (o.label as OutcomeLabel | null) ?? null,
      marketValue: numOrNull(o.market_value_at_horizon),
      netAtHorizon: numOrNull(o.net_at_horizon),
      listingFinalState: String(o.listing_final_state),
      observedAt: new Date(o.observed_at as string),
    })),
    decisions: decs.rows.map((x) => ({
      recommendationId: Number(x.recommendation_id),
      action: x.action as ReportDecision['action'],
      reason: (x.reason as string | null) ?? null,
      createdAt: new Date(x.created_at as string),
    })),
  };
}
