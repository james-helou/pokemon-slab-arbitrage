import type { Channel } from '../channels/channels.js';
import type { RedFlag, Valuation } from '../domain/types.js';
import type { Settings } from '../settings/settings.js';
import { buyTotal as computeBuyTotal, netProfit, round2 } from './fees.js';

export const SCORER_VERSION = 'v1.0.0';

export interface ChannelNet {
  channel: string;
  salePrice: number;
  net: number;
  daysToSell: number | null;
}

export interface ScoreInput {
  price: number;
  shipping: number;
  valuation: Pick<Valuation, 'value' | 'confidence'>;
  matchConfidence: number;
  redFlags: RedFlag[];
  channels: Channel[];
  settings: Pick<Settings, 'minNet' | 'minRoi' | 'alertRatio' | 'valueFloor' | 'buyTaxRate'>;
  availableCash: number;
}

export interface ScoreResult {
  buyTotal: number;
  channelNets: ChannelNet[];
  bestChannel: string | null;
  bestNet: number;
  roi: number;
  confidence: number;
  rank: number;
  decision: 'alert' | 'over_budget' | 'reject';
  rejectReasons: string[];
  scorerVersion: string;
}

export function score(input: ScoreInput): ScoreResult {
  const { settings, valuation } = input;
  if (![input.price, input.shipping, valuation.value, valuation.confidence, input.matchConfidence].every(Number.isFinite)) {
    return {
      buyTotal: 0,
      channelNets: [],
      bestChannel: null,
      bestNet: 0,
      roi: 0,
      confidence: 0,
      rank: 0,
      decision: 'reject',
      rejectReasons: ['invalid_input'],
      scorerVersion: SCORER_VERSION,
    };
  }
  const bt = computeBuyTotal(input.price, input.shipping, settings.buyTaxRate);

  const channelNets: ChannelNet[] = input.channels
    .filter((c) => c.enabled)
    .map((c) => {
      const salePrice = round2(valuation.value * c.priceFactor);
      return { channel: c.name, salePrice, net: netProfit(c, salePrice, bt), daysToSell: c.avgDaysToSell };
    });

  const best = channelNets.reduce<ChannelNet | null>((acc, c) => (acc === null || c.net > acc.net ? c : acc), null);
  const bestNet = best ? best.net : 0;
  const penalty = input.redFlags.reduce((acc, f) => acc * (1 - Math.min(1, Math.max(0, f.confidencePenalty))), 1);
  const confidence = Math.round(Math.min(1, Math.max(0, valuation.confidence * input.matchConfidence * penalty)) * 1000) / 1000;
  // roi is 0 when buyTotal is 0, which makes it reject (deliberately conservative).
  const roi = bt > 0 ? Math.round((bestNet / bt) * 10_000) / 10_000 : 0;

  const rejectReasons: string[] = [];
  if (!best) rejectReasons.push('no_enabled_channel');
  if (valuation.value < settings.valueFloor) rejectReasons.push('below_value_floor');
  if (bt > settings.alertRatio * valuation.value) rejectReasons.push('price_above_alert_ratio');
  if (best) {
    if (bestNet < settings.minNet) rejectReasons.push('net_below_min');
    if (roi < settings.minRoi) rejectReasons.push('roi_below_min');
  }
  for (const f of input.redFlags) if (f.blocking) rejectReasons.push(`red_flag:${f.code}`);

  const decision = rejectReasons.length > 0 ? 'reject' : bt > input.availableCash ? 'over_budget' : 'alert';

  return {
    buyTotal: bt,
    channelNets,
    bestChannel: best ? best.channel : null,
    bestNet,
    roi,
    confidence,
    rank: round2(bestNet * confidence),
    decision,
    rejectReasons,
    scorerVersion: SCORER_VERSION,
  };
}
