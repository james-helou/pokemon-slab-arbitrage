import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/settings.js';
import { belowGap, decideWatch, type WatchState } from '../../src/watch/watch-rule.js';

const t = DEFAULT_SETTINGS;
const st = (o: Partial<WatchState> = {}): WatchState => ({ bid: 3000, bidCount: 2, value: 2000, alertedBid: null, realerted: false, ...o });

describe('decideWatch', () => {
  it('alerts when the bid beats value by both gaps', () => {
    expect(decideWatch(st(), t)).toEqual({ action: 'alert', gapUsd: 1000, gapPct: 0.5 });
  });

  it('refuses a single bid', () => {
    expect(decideWatch(st({ bidCount: 1 }), t)).toEqual({ action: 'none', reason: 'few_bids' });
  });

  it('needs the $ gap as well as the % gap', () => {
    expect(decideWatch(st({ bid: 240, value: 190 }), t)).toEqual({ action: 'none', reason: 'below_gap' });
  });

  it('needs the % gap as well as the $ gap', () => {
    expect(decideWatch(st({ bid: 2400, value: 2000 }), t)).toEqual({ action: 'none', reason: 'below_gap' });
  });

  it('alerts at exactly 25% and $200', () => {
    expect(decideWatch(st({ bid: 1000, value: 800 }), t)).toEqual({ action: 'alert', gapUsd: 200, gapPct: 0.25 });
  });

  it('re-alerts once on a further 25% climb', () => {
    expect(decideWatch(st({ bid: 3700, alertedBid: 3000 }), t)).toEqual({ action: 'none', reason: 'already_alerted' });
    expect(decideWatch(st({ bid: 3750, alertedBid: 3000 }), t)).toEqual({ action: 'realert', gapUsd: 1750, gapPct: 0.875 });
    expect(decideWatch(st({ bid: 5000, alertedBid: 3000, realerted: true }), t)).toEqual({ action: 'none', reason: 'already_alerted' });
  });

  it('never alerts without a value', () => {
    expect(decideWatch(st({ value: null }), t)).toEqual({ action: 'none', reason: 'no_value' });
    expect(decideWatch(st({ value: 0 }), t)).toEqual({ action: 'none', reason: 'no_value' });
  });
});

describe('belowGap', () => {
  it('matches decideWatch: below either gap is below, exactly at both is not', () => {
    expect(belowGap(1000, 800, t)).toBe(false);
    expect(belowGap(999.99, 800, t)).toBe(true);
    expect(belowGap(3000, 2900, t)).toBe(true);
    expect(decideWatch(st({ bid: 1000, value: 800 }), t).action).toBe('alert');
  });
});
