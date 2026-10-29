import { describe, expect, it } from 'vitest';
import { buildWatchPayload, type WatchAlert } from '../../src/discord/watch-payload.js';

const NOW = new Date('2026-10-28T12:00:00Z');
const ENDS = new Date('2026-10-28T14:00:00Z');

const alert = (over: Partial<WatchAlert> = {}): WatchAlert => ({
  title: 'PSA 10 Charizard Base Set 4/102', url: 'https://www.ebay.com/itm/123', imageUrl: 'https://i.ebayimg.com/x.jpg',
  cardName: 'Charizard', setName: 'Base', number: '4', grader: 'PSA', grade: 10,
  bid: 3000, bidCount: 5, endsAt: ENDS, value: 2000,
  sources: [
    { name: 'ppt', value: 2000, saleCount: 12, asOf: NOW },
    { name: 'own_sales', value: 1850, saleCount: 4, asOf: NOW },
  ],
  gapUsd: 1000, gapPct: 0.5, realert: false,
  ...over,
});

const fields = (p: ReturnType<typeof buildWatchPayload>) =>
  Object.fromEntries((p.embeds[0]!.fields ?? []).map((f) => [f.name, f.value]));

describe('buildWatchPayload', () => {
  it('titles, links and lists bid, value per source, gap and end time', () => {
    const p = buildWatchPayload(alert(), { now: NOW });
    const e = p.embeds[0]!;
    expect(e.title).toBe('Bid above market: Charizard PSA 10');
    expect(e.url).toBe('https://www.ebay.com/itm/123');
    expect(e.image).toEqual({ url: 'https://i.ebayimg.com/x.jpg' });
    expect(e.description).toContain('Base #4');
    const f = fields(p);
    expect(f['Current bid']).toBe('$3,000.00 (5 bids)');
    expect(f['Market value']).toBe('$2,000.00\nppt $2,000.00 (12 sales)\nown_sales $1,850.00 (4 sales)');
    expect(f['Gap']).toBe('+$1,000.00 (+50%)');
    expect(f['Ends']).toBe(`<t:${ENDS.getTime() / 1000}:R>`);
    expect(f['Link']).toBe('https://www.ebay.com/itm/123');
    expect(p.components).toEqual([]);
  });

  it('formats large and small amounts with thousands separators and cents', () => {
    const f = fields(buildWatchPayload(alert({ bid: 1234567.5, value: 999.994, gapUsd: 0.5 }), { now: NOW }));
    expect(f['Current bid']).toBe('$1,234,567.50 (5 bids)');
    expect(f['Market value']!.split('\n')[0]).toBe('$999.99');
    expect(f['Gap']).toBe('+$0.50 (+50%)');
  });

  it('uses the re-alert title', () => {
    expect(buildWatchPayload(alert({ realert: true }), { now: NOW }).embeds[0]!.title)
      .toBe('Still climbing: Charizard PSA 10');
  });

  it('adds CAD when a rate is known, none otherwise', () => {
    expect(fields(buildWatchPayload(alert(), { now: NOW, usdCad: 1.4 }))['Current bid'])
      .toBe('$3,000.00 (5 bids) (≈ C$4,200.00)');
    expect(fields(buildWatchPayload(alert(), { now: NOW, usdCad: null }))['Current bid']).not.toContain('C$');
  });

  it('drops a non-eBay url and a missing image', () => {
    const p = buildWatchPayload(alert({ url: 'https://evil.example/x', imageUrl: null }), { now: NOW });
    expect(p.embeds[0]!.url).toBeUndefined();
    expect(p.embeds[0]!.image).toBeUndefined();
    expect(fields(p)['Link']).toBeUndefined();
  });

  it('singular bid and a fractional grade', () => {
    const f = fields(buildWatchPayload(alert({ bidCount: 1, grade: 9.5, gapPct: 0.2549 }), { now: NOW }));
    expect(f['Current bid']).toBe('$3,000.00 (1 bid)');
    expect(f['Gap']).toBe('+$1,000.00 (+25%)');
  });
});
