import type { CompKind } from '../domain/types.js';

export const ORACLE_VERSION = 'v1.0.0';

export interface CompPoint {
  price: number;
  soldAt: Date;
  kind: CompKind;
}

export interface ComputedValuation {
  value: number;
  low: number;
  high: number;
  compCount: number;
  newestCompAgeDays: number;
  confidence: number;
}

const DAY_MS = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

function quantile(sorted: number[], p: number): number {
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function computeValuation(comps: CompPoint[], now: Date, opts: { boDiscount: number; minCompCount: number }): ComputedValuation | null {
  const adjusted = comps.map((c) => ({
    price: c.kind === 'paid_source' ? c.price : c.price * opts.boDiscount,
    ageDays: Math.max(0, (now.getTime() - c.soldAt.getTime()) / DAY_MS),
  }));
  const recent = adjusted.filter((a) => a.ageDays <= 14);
  const used = recent.length >= 3 ? recent : adjusted.filter((a) => a.ageDays <= 90);
  if (used.length === 0 || used.length < opts.minCompCount) return null;

  const prices = used.map((u) => u.price).sort((a, b) => a - b);
  const value = quantile(prices, 0.5);
  const low = quantile(prices, 0.25);
  const high = quantile(prices, 0.75);
  const newest = Math.min(...used.map((u) => u.ageDays));

  const countScore = Math.min(1, used.length / 8);
  const ageScore = newest <= 7 ? 1 : newest <= 30 ? 0.7 : 0.4;
  const spreadScore = value > 0 ? 1 - Math.min(1, (high - low) / value) : 0;
  const confidence = Math.round((0.4 * countScore + 0.3 * ageScore + 0.3 * spreadScore) * 1000) / 1000;

  return {
    value: round2(value), low: round2(low), high: round2(high),
    compCount: used.length, newestCompAgeDays: round2(newest), confidence,
  };
}
