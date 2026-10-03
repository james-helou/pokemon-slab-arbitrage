import type { Channel } from '../channels/channels.js';
import { netProfit, round2 } from '../scoring/fees.js';

/** Spec §3 module 11: outcomes at 7, 14 and 30 days. The 30-day row is the canonical label. */
export const HORIZONS_DAYS = [7, 14, 30] as const;

export type OutcomeLabel = 'good' | 'marginal' | 'bad';

/** Spec §5: good if net >= minNet, marginal if 0 <= net < minNet, bad if net < 0. */
export function labelForNet(net: number, minNet: number): OutcomeLabel {
  if (net >= minNet) return 'good';
  return net >= 0 ? 'marginal' : 'bad';
}

/**
 * Counterfactual net (spec §5): sell at the horizon market value through the best enabled channel,
 * minus that channel's fees and the buy total we would have paid. Same math as the scorer.
 */
export function counterfactualNet(
  channels: Channel[],
  marketValue: number,
  buyTotal: number,
): { channel: string; net: number } | null {
  let best: { channel: string; net: number } | null = null;
  for (const c of channels) {
    if (!c.enabled) continue;
    const net = netProfit(c, round2(marketValue * c.priceFactor), buyTotal);
    if (!best || net > best.net) best = { channel: c.name, net };
  }
  return best;
}
