import { round2 } from '../scoring/fees.js';
import type { Settings } from '../settings/settings.js';

export type WatchVerdict =
  | { action: 'alert' | 'realert'; gapUsd: number; gapPct: number }
  | { action: 'none'; reason: 'few_bids' | 'below_gap' | 'already_alerted' | 'no_value' };

export interface WatchState { bid: number; bidCount: number; value: number | null; alertedBid: number | null; realerted: boolean }

export type WatchThresholds = Pick<Settings, 'watchMinBids' | 'watchMinGapPct' | 'watchMinGapUsd' | 'watchRealertPct'>;

/** Alert when the bid beats market value by both the % and $ gaps (2+ bids); re-alert once on a further climb. */
export function decideWatch(s: WatchState, t: WatchThresholds): WatchVerdict {
  if (s.bidCount < t.watchMinBids) return { action: 'none', reason: 'few_bids' };
  if (s.value === null || !(s.value > 0)) return { action: 'none', reason: 'no_value' };
  // Thresholds rounded to cents so 800 * 1.25 is exactly 1000, not a float hair above it.
  if (s.bid < round2(s.value * (1 + t.watchMinGapPct)) || round2(s.bid - s.value) < t.watchMinGapUsd) {
    return { action: 'none', reason: 'below_gap' };
  }
  const gap = { gapUsd: round2(s.bid - s.value), gapPct: Math.round((s.bid / s.value - 1) * 10_000) / 10_000 };
  if (s.alertedBid === null) return { action: 'alert', ...gap };
  if (!s.realerted && s.bid >= round2(s.alertedBid * (1 + t.watchRealertPct))) return { action: 'realert', ...gap };
  return { action: 'none', reason: 'already_alerted' };
}
