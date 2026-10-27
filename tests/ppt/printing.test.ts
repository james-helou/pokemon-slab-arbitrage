import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePptCard } from '../../src/ppt/aggregate-source.js';

// Real response (2026-10-25): Team Rocket Dark Charizard lists Unlimited and 1st Edition printings. salesByGrade mixes
// both editions (psa9 smart price 3780, psa8 1388); Unlimited-only sales are psa6 290 x1, psa8 465 x1 + 493 x1.
const DARK_CHARIZARD = JSON.parse(readFileSync('tests/fixtures/ppt/base5-4-dark-charizard-2026-10-25.json', 'utf8')) as unknown;
const NOW = new Date('2026-10-25T12:00:00Z');
const CTX = { now: NOW, tcgplayerId: '84572' };

/** A multi-printing card whose Unlimited history has the given psa8 sales (day -> [average, count]). */
function multiPrinting(sales: Record<string, [number, number]>, printings = ['Unlimited Holofoil', '1st Edition Holofoil']) {
  const history = Object.fromEntries(Object.entries(sales).map(([day, [average, count]]) => [day, { count, average, totalValue: average * count }]));
  return {
    data: {
      tcgPlayerId: '1',
      variants: Object.fromEntries(printings.map((p) => [p, { printing: p, marketPrice: 100 }])),
      ebay: {
        updatedAt: '2026-10-25T06:00:00.000Z',
        salesByGrade: {
          psa8: {
            smartMarketPrice: { price: 5000, method: '7day_filtered_weighted', daysUsed: 7, confidence: 'high' },
            marketPriceMedian7Day: 5000, lastSaleDate: '2026-10-24T00:00:00.000Z', dailyVolume7Day: 2,
            lastMarketUpdate: '2026-10-25T06:00:00.000Z',
          },
        },
        smartPriceOutlierByGrade: { psa8: false },
        salesByPrinting: Object.fromEntries(printings.map((p) => [p, { priceHistory: /unlimited/i.test(p) ? { psa8: history } : {} }])),
      },
    },
  };
}

describe('parsePptCard with several printings (vintage editions)', () => {
  it('never uses the mixed-edition grade price: real Dark Charizard PSA 9 has no Unlimited sales', () => {
    expect(parsePptCard(DARK_CHARIZARD, { grader: 'PSA', grade: 9 }, CTX)).toBeNull();
  });

  it('refuses fewer than 3 recent Unlimited sales: real Dark Charizard PSA 8 has 2', () => {
    expect(parsePptCard(DARK_CHARIZARD, { grader: 'PSA', grade: 8 }, CTX)).toBeNull();
  });

  it('prices from Unlimited-only sales: count-weighted median, low/high from the daily averages', () => {
    const v = parsePptCard(
      multiPrinting({ '2026-10-20': [400, 1], '2026-10-22': [460, 2], '2026-10-24': [520, 1], '2026-08-01': [9000, 5] }),
      { grader: 'PSA', grade: 8 }, { now: NOW, tcgplayerId: '1' },
    );
    expect(v).toMatchObject({ value: 460, low: 400, high: 520, saleCount: 4, sourceName: 'ppt' });
  });

  it('refuses when no printing, or more than one, is Unlimited', () => {
    const key = { grader: 'PSA' as const, grade: 8 };
    const sales = { '2026-10-20': [400, 3] as [number, number] };
    expect(parsePptCard(multiPrinting(sales, ['1st Edition Holofoil', 'Shadowless Holofoil']), key, { now: NOW, tcgplayerId: '1' })).toBeNull();
    expect(parsePptCard(multiPrinting(sales, ['Unlimited Holofoil', 'Unlimited Normal']), key, { now: NOW, tcgplayerId: '1' })).toBeNull();
    // A reverse printing is another card (reverse titles never match), so it does not make Unlimited ambiguous.
    expect(parsePptCard(multiPrinting(sales, ['Unlimited Holofoil', 'Unlimited Reverse Holofoil']), key, { now: NOW, tcgplayerId: '1' })?.value).toBe(400);
  });

  it('a single-printing card still uses the grade price', () => {
    const v = parsePptCard(multiPrinting({}, ['Holofoil']), { grader: 'PSA', grade: 8 }, { now: NOW, tcgplayerId: '1' });
    expect(v?.value).toBe(5000);
  });
});
