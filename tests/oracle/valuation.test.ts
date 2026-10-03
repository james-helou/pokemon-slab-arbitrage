import { describe, expect, it } from 'vitest';
import { computeValuation, ORACLE_VERSION, type CompPoint } from '../../src/oracle/valuation.js';

const NOW = new Date('2026-10-03T12:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const paid = (price: number, days: number): CompPoint => ({ price, soldAt: ago(days), kind: 'paid_source' });

it('ORACLE_VERSION is v1.1.0 (USD-required aggregates)', () => {
  expect(ORACLE_VERSION).toBe('v1.1.0');
});

describe('computeValuation', () => {
  it('returns null with no comps', () => {
    expect(computeValuation([], NOW, { boDiscount: 0.92, minCompCount: 3 })).toBeNull();
  });

  it('uses median and quartiles of recent comps', () => {
    const v = computeValuation([paid(100, 1), paid(110, 2), paid(120, 3), paid(130, 5)], NOW, { boDiscount: 0.92, minCompCount: 3 });
    expect(v).toEqual({ value: 115, low: 107.5, high: 122.5, compCount: 4, newestCompAgeDays: 1, confidence: 0.761 });
  });

  it('falls back to the 90-day window when fewer than 3 comps are within 14 days', () => {
    const v = computeValuation([paid(100, 3), paid(200, 20), paid(300, 40)], NOW, { boDiscount: 0.92, minCompCount: 3 });
    expect(v?.value).toBe(200);
    expect(v?.compCount).toBe(3);
  });

  it('ignores comps older than 90 days', () => {
    expect(computeValuation([paid(100, 100)], NOW, { boDiscount: 0.92, minCompCount: 3 })).toBeNull();
  });

  it('discounts non-paid comps for hidden Best Offer prices', () => {
    const bin = (days: number): CompPoint => ({ price: 100, soldAt: ago(days), kind: 'disappearing_bin' });
    const v = computeValuation([bin(1), bin(2), bin(3)], NOW, { boDiscount: 0.92, minCompCount: 3 });
    expect(v?.value).toBe(92);
  });

  it('lowers confidence for old comps', () => {
    const v = computeValuation([paid(100, 40), paid(100, 50), paid(100, 60)], NOW, { boDiscount: 0.92, minCompCount: 3 });
    expect(v?.confidence).toBe(0.57);
  });

  it('returns null when fewer comps than minCompCount', () => {
    expect(computeValuation([paid(100, 1)], NOW, { boDiscount: 0.92, minCompCount: 3 })).toBeNull();
    expect(computeValuation([paid(100, 1)], NOW, { boDiscount: 0.92, minCompCount: 1 })?.value).toBe(100);
  });

  it('clamps future-dated comps to age 0', () => {
    const v = computeValuation([paid(100, -2), paid(100, 1), paid(100, 2)], NOW, { boDiscount: 0.92, minCompCount: 3 });
    expect(v?.newestCompAgeDays).toBe(0);
  });
});
