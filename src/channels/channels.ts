import type { Db } from '../db/db.js';

export interface Channel {
  name: string;
  enabled: boolean;
  /** Expected sale price on this channel = market value x priceFactor. */
  priceFactor: number;
  feePct: number;
  feeTierThreshold: number | null;
  feePctAboveTier: number | null;
  feeCap: number | null;
  paymentPct: number;
  paymentFlat: number;
  orderFlatFee: number;
  outboundShipping: number;
  supplies: number;
  avgDaysToSell: number | null;
}

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function loadChannels(db: Db): Promise<Channel[]> {
  const { rows } = await db.query<Record<string, unknown>>('select * from channels order by name');
  return rows.map((r) => ({
    name: String(r.name),
    enabled: Boolean(r.enabled),
    priceFactor: num(r.price_factor),
    feePct: num(r.fee_pct),
    feeTierThreshold: numOrNull(r.fee_tier_threshold),
    feePctAboveTier: numOrNull(r.fee_pct_above_tier),
    feeCap: numOrNull(r.fee_cap),
    paymentPct: num(r.payment_pct),
    paymentFlat: num(r.payment_flat),
    orderFlatFee: num(r.order_flat_fee),
    outboundShipping: num(r.outbound_shipping),
    supplies: num(r.supplies),
    avgDaysToSell: numOrNull(r.avg_days_to_sell),
  }));
}
