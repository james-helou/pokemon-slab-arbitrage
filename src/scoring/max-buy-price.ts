import { score, type ScoreInput } from './scorer.js';

/** Highest item price (USD, cents, rounded down) at which score() has no reject reasons, with shipping/tax fixed. Null if none. */
export function maxBuyPrice(input: Omit<ScoreInput, 'price'>): number | null {
  const ok = (cents: number): boolean => score({ ...input, price: cents / 100 }).rejectReasons.length === 0;
  const { alertRatio, buyTaxRate, fxFeePct } = input.settings;
  // Above this the buy total exceeds the alert ratio, so it always fails.
  let hi = Math.ceil(
    ((alertRatio * input.valuation.value) / (1 + buyTaxRate + fxFeePct) - input.shipping) * 100,
  ) + 1;
  // Price 0 with shipping 0 is rejected (buy total 0 -> ROI 0), so the search starts at 1 cent.
  if (!Number.isFinite(hi) || hi < 1 || !ok(1)) return null;
  for (let i = 0; ok(hi); i++) {
    if (i >= 30) return null;
    hi *= 2;
  }
  let lo = 1;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo / 100;
}
