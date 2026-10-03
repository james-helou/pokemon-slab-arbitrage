import type { Channel } from '../channels/channels.js';

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Everything the seller pays on a sale at `salePrice` through `ch` (commission, payment, flat, shipping, supplies). */
export function channelCosts(ch: Channel, salePrice: number): number {
  let commission: number;
  if (ch.feeTierThreshold !== null && ch.feePctAboveTier !== null && salePrice > ch.feeTierThreshold) {
    commission = ch.feeTierThreshold * ch.feePct + (salePrice - ch.feeTierThreshold) * ch.feePctAboveTier;
  } else {
    commission = salePrice * ch.feePct;
  }
  if (ch.feeCap !== null) commission = Math.min(commission, ch.feeCap);
  const payment = salePrice * ch.paymentPct + ch.paymentFlat;
  return round2(commission + payment + ch.orderFlatFee + ch.outboundShipping + ch.supplies);
}

export function buyTotal(price: number, shipping: number, taxRate: number): number {
  return round2((price + shipping) * (1 + taxRate));
}

export function netProfit(ch: Channel, salePrice: number, totalCost: number): number {
  return round2(salePrice - channelCosts(ch, salePrice) - totalCost);
}
