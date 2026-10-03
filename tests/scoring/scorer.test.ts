import { describe, expect, it } from 'vitest';
import { score, type ScoreInput } from '../../src/scoring/scorer.js';
import { DEFAULT_SETTINGS } from '../../src/settings/settings.js';
import { EBAY, LOCAL_DISABLED, TCGPLAYER } from '../helpers/channels.js';

const base: ScoreInput = {
  price: 350,
  shipping: 5,
  valuation: { value: 600, confidence: 0.8 },
  matchConfidence: 0.9,
  redFlags: [],
  channels: [EBAY, TCGPLAYER, LOCAL_DISABLED],
  settings: DEFAULT_SETTINGS,
  availableCash: 500,
};

describe('score', () => {
  it('alerts on a good, affordable deal and picks the best channel', () => {
    const r = score(base);
    expect(r.decision).toBe('alert');
    expect(r.buyTotal).toBe(379.85);
    expect(r.bestChannel).toBe('ebay');
    expect(r.bestNet).toBe(133.75);
    expect(r.roi).toBe(0.3521);
    expect(r.confidence).toBe(0.72);
    expect(r.rank).toBe(96.3);
    expect(r.channelNets.map((c) => c.channel)).toEqual(['ebay', 'tcgplayer']);
    expect(r.scorerVersion).toMatch(/^v\d/);
  });

  it('routes to over_budget when buy total exceeds available cash', () => {
    expect(score({ ...base, availableCash: 300 }).decision).toBe('over_budget');
  });

  it('rejects when price is above the alert ratio and net is too small', () => {
    const r = score({ ...base, price: 500 });
    expect(r.decision).toBe('reject');
    expect(r.rejectReasons).toContain('price_above_alert_ratio');
    expect(r.rejectReasons).toContain('net_below_min');
  });

  it('rejects below the value floor', () => {
    const r = score({ ...base, price: 20, valuation: { value: 100, confidence: 0.8 } });
    expect(r.rejectReasons).toContain('below_value_floor');
  });

  it('applies red-flag confidence penalties', () => {
    const r = score({ ...base, redFlags: [{ code: 'no_cert', blocking: false, confidencePenalty: 0.2 }] });
    expect(r.confidence).toBe(0.576);
    expect(r.decision).toBe('alert');
  });

  it('rejects on a blocking red flag', () => {
    const r = score({ ...base, redFlags: [{ code: 'fake_target', blocking: true, confidencePenalty: 0 }] });
    expect(r.decision).toBe('reject');
    expect(r.rejectReasons).toContain('red_flag:fake_target');
  });

  it('only considers enabled channels', () => {
    const r = score({ ...base, channels: [{ ...EBAY, enabled: false }, TCGPLAYER] });
    expect(r.bestChannel).toBe('tcgplayer');
  });

  it('rejects when no channel is enabled', () => {
    const r = score({ ...base, channels: [LOCAL_DISABLED] });
    expect(r.decision).toBe('reject');
    expect(r.rejectReasons).toContain('no_enabled_channel');
  });
});
