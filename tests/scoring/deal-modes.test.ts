import { describe, expect, it } from 'vitest';
import { decideDeal } from '../../src/scoring/deal-modes.js';
import type { ScoreInput } from '../../src/scoring/scorer.js';
import { DEFAULT_SETTINGS } from '../../src/settings/settings.js';
import { EBAY, LOCAL_DISABLED, TCGPLAYER } from '../helpers/channels.js';

const base: Omit<ScoreInput, 'price'> = {
  shipping: 20,
  valuation: { value: 600, confidence: 0.9 },
  matchConfidence: 0.9,
  redFlags: [],
  channels: [EBAY, TCGPLAYER, LOCAL_DISABLED],
  settings: DEFAULT_SETTINGS,
  availableCash: 1_000_000,
};
const settings = { offerMinPctOfAsk: 0.75, auctionAlertPct: 0.7 };

describe('decideDeal', () => {
  it('bin_offer: an ask that already passes stays a bin alert', () => {
    const d = decideDeal({ mode: 'bin_offer', ask: 352, base, settings });
    expect(d.kind).toBe('bin');
    expect(d.suggestedPrice).toBeNull();
  });

  it('bin_offer: suggests a $5-rounded offer and stores the economics at that price', () => {
    const d = decideDeal({ mode: 'bin_offer', ask: 450, base, settings });
    expect(d.kind).toBe('offer');
    expect(d.maxPrice).toBe(352.26);
    expect(d.suggestedPrice).toBe(350);
    expect(d.score.buyTotal).toBe(425.41);
    expect(d.score.bestNet).toBe(88.19);
    expect(d.score.roi).toBe(0.2073);
  });

  it('bin_offer: offerMinPctOfAsk threshold is compared in cents', () => {
    expect(decideDeal({ mode: 'bin_offer', ask: 469.68, base, settings }).kind).toBe('offer');
    const deep = decideDeal({ mode: 'bin_offer', ask: 469.69, base, settings });
    expect(deep.kind).toBeNull();
    expect(deep.reasons).toContain('offer_too_deep');
    const way = decideDeal({ mode: 'bin_offer', ask: 480, base, settings });
    expect(way.kind).toBeNull();
    expect(way.reasons).toEqual(expect.arrayContaining(['price_above_alert_ratio', 'offer_too_deep']));
  });

  it('bin_offer: rejects when nothing can pass', () => {
    const d = decideDeal({ mode: 'bin_offer', ask: 450, base: { ...base, valuation: { value: 100, confidence: 0.9 } }, settings });
    expect(d.kind).toBeNull();
    expect(d.reasons).toContain('offer_too_deep');
  });

  it('auction: suggests the max bid and stores worst-case economics', () => {
    const d = decideDeal({ mode: 'auction', ask: 200, base, settings });
    expect(d.kind).toBe('auction');
    expect(d.suggestedPrice).toBe(352.26);
    expect(d.score.buyTotal).toBe(428.01);
  });

  it('auction: alerts only while bid <= auctionAlertPct x max', () => {
    expect(decideDeal({ mode: 'auction', ask: 246.58, base, settings }).kind).toBe('auction');
    const d = decideDeal({ mode: 'auction', ask: 246.59, base, settings });
    expect(d.kind).toBeNull();
    expect(d.reasons).toEqual(['auction_bid_too_high']);
  });

  it('auction: no solution returns the scorer reasons', () => {
    const d = decideDeal({ mode: 'auction', ask: 50, base: { ...base, valuation: { value: 100, confidence: 0.9 } }, settings });
    expect(d.kind).toBeNull();
    expect(d.reasons).toContain('below_value_floor');
  });

  it('bin: rejects with the scorer reasons', () => {
    const d = decideDeal({ mode: 'bin', ask: 450, base, settings });
    expect(d.kind).toBeNull();
    expect(d.reasons).toContain('price_above_alert_ratio');
    expect(d.maxPrice).toBeNull();
  });

  it('bin: passing ask is a bin', () => {
    expect(decideDeal({ mode: 'bin', ask: 350, base, settings }).kind).toBe('bin');
  });

  it('routes an auction over available cash to over_budget', () => {
    const d = decideDeal({ mode: 'auction', ask: 200, base: { ...base, availableCash: 400 }, settings });
    expect(d.kind).toBe('auction');
    expect(d.score.decision).toBe('over_budget');
  });
});
