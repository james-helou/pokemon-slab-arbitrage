import { describe, expect, it } from 'vitest';
import { maxBuyPrice } from '../../src/scoring/max-buy-price.js';
import { score, type ScoreInput } from '../../src/scoring/scorer.js';
import { DEFAULT_SETTINGS } from '../../src/settings/settings.js';
import { EBAY, LOCAL_DISABLED, TCGPLAYER } from '../helpers/channels.js';

type Base = Omit<ScoreInput, 'price'>;

function base(value: number, shipping: number, over: Partial<Base> = {}): Base {
  return {
    shipping,
    valuation: { value, confidence: 0.9 },
    matchConfidence: 0.9,
    redFlags: [],
    channels: [EBAY, TCGPLAYER, LOCAL_DISABLED],
    settings: DEFAULT_SETTINGS,
    availableCash: 1_000_000,
    ...over,
  };
}

const passes = (b: Base, cents: number): boolean => score({ ...b, price: cents / 100 }).rejectReasons.length === 0;

const CASES: [number, number, number][] = [
  [600, 20, 352.26],
  [600, 0, 372.26],
  [600, 35, 337.26],
  [300, 20, 135.12],
  [1000, 20, 603.78],
  [150, 20, 21.94],
];

/**
 * Scans every cent in a band around the solver result and $1 steps elsewhere (a full cent scan is ~1M scorer
 * calls). Asserts the passing set is exactly [1 cent, max] over the scanned points.
 */
function expectDownwardClosed(b: Base, max: number, bandDollars: number, topDollars: number): void {
  const maxCents = Math.round(max * 100);
  const points = new Set<number>();
  for (let c = Math.max(1, maxCents - bandDollars * 100); c <= maxCents + bandDollars * 100; c++) points.add(c);
  for (let d = 1; d <= topDollars; d++) points.add(d * 100 + 1);
  for (const c of points) expect(passes(b, c), `value ${b.valuation.value} ship ${b.shipping} cents ${c}`).toBe(c <= maxCents);
}

describe('maxBuyPrice', () => {
  it.each(CASES)('value %d, shipping %d -> %d', (value, shipping, expected) => {
    const b = base(value, shipping);
    const max = maxBuyPrice(b);
    expect(max).toBe(expected);
    expect(passes(b, Math.round(max! * 100))).toBe(true);
    expect(passes(b, Math.round(max! * 100) + 1)).toBe(false);
  });

  it('returns null when nothing can pass', () => {
    expect(maxBuyPrice(base(100, 20))).toBeNull();
    expect(maxBuyPrice(base(600, 20, { redFlags: [{ code: 'lot', blocking: true, confidencePenalty: 0 }] }))).toBeNull();
    expect(maxBuyPrice(base(600, 20, { channels: [LOCAL_DISABLED] }))).toBeNull();
    expect(maxBuyPrice(base(Number.NaN, 20))).toBeNull();
    expect(maxBuyPrice(base(Number.POSITIVE_INFINITY, 20))).toBeNull();
  });

  it('price 0 with shipping 0 rejects, which is why the solver starts at 1 cent', () => {
    const r = score({ ...base(600, 0), price: 0 });
    expect(r.rejectReasons).toContain('roi_below_min');
  });

  describe('monotonic assumption (pass set is downward closed)', () => {
    for (const value of [150, 200, 600, 1000, 2500]) {
      it(`value ${value}`, () => {
        for (const shipping of [0, 20, 35]) {
          const b = base(value, shipping);
          const max = maxBuyPrice(b);
          if (max === null) continue;
          expectDownwardClosed(b, max, 30, Math.ceil(max) + 50);
        }
      });
    }
  });

  it('agrees with a brute-force scan on 20 seeded random value/shipping pairs', () => {
    let seed = 42;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    let solved = 0;
    for (let i = 0; i < 20; i++) {
      const value = 150 + Math.round(rnd() * 2850 * 100) / 100;
      const shipping = Math.round(rnd() * 60 * 100) / 100;
      const b = base(value, shipping);
      const max = maxBuyPrice(b);
      if (max === null) {
        expect(passes(b, 1)).toBe(false);
        continue;
      }
      solved++;
      expectDownwardClosed(b, max, 10, Math.ceil(max) + 20);
    }
    expect(solved).toBeGreaterThan(10);
  });
});
