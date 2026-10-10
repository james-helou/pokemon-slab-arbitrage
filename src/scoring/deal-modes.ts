import type { Settings } from '../settings/settings.js';
import { maxBuyPrice } from './max-buy-price.js';
import { score, type ScoreInput, type ScoreResult } from './scorer.js';

export type DealKind = 'bin' | 'offer' | 'auction';
export type DealMode = 'bin' | 'bin_offer' | 'auction';

export interface DealDecision {
  kind: DealKind | null; // null = reject
  /** The score stored on the recommendation. */
  score: ScoreResult;
  /** offer: rounded-down-to-$5 offer; auction: max bid (cents). */
  suggestedPrice: number | null;
  /** Raw solver output. */
  maxPrice: number | null;
  /** Reject reasons when kind is null. */
  reasons: string[];
}

const cents = (usd: number): number => Math.round(usd * 100);

export function decideDeal(i: {
  mode: DealMode;
  /** List price (bin/offer) or current bid (auction). */
  ask: number;
  base: Omit<ScoreInput, 'price'>;
  settings: Pick<Settings, 'offerMinPctOfAsk' | 'auctionAlertPct'>;
}): DealDecision {
  const at = (price: number): ScoreResult => score({ ...i.base, price });
  const atAsk = at(i.ask);
  const reject = (reasons: string[], maxPrice: number | null): DealDecision => ({
    kind: null, score: atAsk, suggestedPrice: null, maxPrice, reasons,
  });

  if (i.mode === 'bin' || (i.mode === 'bin_offer' && atAsk.rejectReasons.length === 0)) {
    return atAsk.rejectReasons.length > 0
      ? reject(atAsk.rejectReasons, null)
      : { kind: 'bin', score: atAsk, suggestedPrice: null, maxPrice: null, reasons: [] };
  }

  const max = maxBuyPrice(i.base);
  const askCents = cents(i.ask);

  if (i.mode === 'bin_offer') {
    const tooDeep = [...atAsk.rejectReasons, 'offer_too_deep'];
    if (max === null || cents(max) < Math.ceil(i.settings.offerMinPctOfAsk * askCents - 1e-9)) return reject(tooDeep, max);
    const suggested = Math.floor(max / 5) * 5;
    if (suggested < 5 || cents(suggested) < Math.ceil(i.settings.offerMinPctOfAsk * askCents - 1e-9)) return reject(tooDeep, max);
    return { kind: 'offer', score: at(suggested), suggestedPrice: suggested, maxPrice: max, reasons: [] };
  }

  if (max === null) return reject(atAsk.rejectReasons, null);
  if (askCents > Math.floor(i.settings.auctionAlertPct * cents(max) + 1e-9)) return reject(['auction_bid_too_high'], max);
  return { kind: 'auction', score: at(max), suggestedPrice: max, maxPrice: max, reasons: [] };
}
