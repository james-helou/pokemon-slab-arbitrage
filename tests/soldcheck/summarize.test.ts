import { describe, expect, it } from 'vitest';
import { findCandidates, findCandidatesInSet } from '../../src/catalog/catalog-repo.js';
import { matchListing, type CandidateLookup } from '../../src/matcher/matcher.js';
import { DEFAULT_SETTINGS } from '../../src/settings/settings.js';
import { parseSoldResults, type ParsedSale } from '../../src/soldcheck/parse.js';
import { median, percentile, summarizeSales } from '../../src/soldcheck/summarize.js';
import { soldHtml } from '../helpers/sold-html.js';
import { createTestDb } from '../helpers/test-db.js';
import { CHARIZARD_151, seedCards } from '../helpers/fixtures.js';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const DAY = 86_400_000;
const key = { cardId: 'sv03.5-199', grader: 'PSA' as const, grade: 10 };
const PIKACHU = { ...CHARIZARD_151, id: 'sv03.5-025', name: 'Pikachu', number: '025' };

async function lookup(): Promise<CandidateLookup> {
  const db = await createTestDb();
  await seedCards(db, [CHARIZARD_151, PIKACHU]);
  return (n, t, promo) => (promo ? findCandidatesInSet(db, promo, n) : findCandidates(db, n, t));
}

const sale = (over: Partial<ParsedSale> = {}): ParsedSale => ({
  title: 'PSA 10 Charizard ex 199/165 151 Special Illustration Rare', price: 600, currency: 'USD',
  soldAt: new Date(NOW.getTime() - 3 * DAY), bestOfferAccepted: false, isLot: false, ...over,
});

const run = async (sales: ParsedSale[]) =>
  summarizeSales(sales, { key, lookup: await lookup(), minMatchConfidence: 0.85, now: NOW });

describe('summarizeSales', () => {
  it('keeps matching sales and summarizes them', async () => {
    const s = await run([
      sale({ price: 600, soldAt: new Date(NOW.getTime() - 5 * DAY) }),
      sale({ price: 620, soldAt: new Date(NOW.getTime() - 1 * DAY), title: 'Charizard ex 199/165 PSA 10 Pokemon 151' }),
      sale({ price: 580, soldAt: new Date(NOW.getTime() - 9 * DAY) }),
    ]);
    expect(s).toMatchObject({ status: 'ok', saleCount: 3, median: 600, low: 590, high: 610 });
    expect(s.newestSoldAt!.toISOString()).toBe(new Date(NOW.getTime() - DAY).toISOString());
    expect(s.matchedTitles).toHaveLength(3);
  });

  it('drops a different grade, grader or grade label', async () => {
    const s = await run([
      sale({ title: 'PSA 9 Charizard ex 199/165 151' }),
      sale({ title: 'CGC 10 Charizard ex 199/165 151' }),
      sale({ title: 'CGC 10 Pristine Charizard ex 199/165 151' }),
    ]);
    expect(s).toMatchObject({ status: 'no_results', saleCount: 0, median: null, low: null, high: null, newestSoldAt: null });
  });

  it('drops a pristine or black label sale even under the same grader and grade', async () => {
    const s = await run([sale({ title: 'PSA 10 Pristine Charizard ex 199/165 151' })]);
    // PSA has no pristine label, but a gradeLabel must never pass as the plain grade.
    expect(s.saleCount).toBe(0);
  });

  it('drops another card', async () => {
    const s = await run([sale({ title: 'PSA 10 Pikachu 025/165 151' }), sale({ title: 'PSA 10 Mew ex 205/165 151' })]);
    expect(s.saleCount).toBe(0);
  });

  it('drops lots, Best Offer, non-USD, undated and old sales', async () => {
    const s = await run([
      sale({ isLot: true }),
      sale({ bestOfferAccepted: true }),
      sale({ currency: 'CAD' as never }),
      sale({ soldAt: null }),
      sale({ soldAt: new Date(NOW.getTime() - 91 * DAY) }),
      sale({ price: 640, soldAt: new Date(NOW.getTime() - 89 * DAY) }),
    ]);
    expect(s).toMatchObject({ status: 'ok', saleCount: 1, median: 640 });
  });

  it('drops a zero, NaN or future-dated sale', async () => {
    const s = await run([
      sale({ price: 0 }),
      sale({ price: Number.NaN }),
      sale({ soldAt: new Date(NOW.getTime() + 2 * DAY) }),
      sale({ price: 610 }),
    ]);
    expect(s).toMatchObject({ status: 'ok', saleCount: 1, median: 610 });
  });

  it('drops parsed lots (x2, 2x, pair, duo) and keeps single-card titles', async () => {
    const titles = [
      'PSA 10 Charizard ex 199/165 151 x2',
      '2x PSA 10 Charizard ex 199/165 151',
      'PSA 10 Charizard ex 199/165 151 pair',
      'PSA 10 Charizard ex 199/165 151 Duo',
      'PSA 10 Charizard ex 199/165 151 Special Illustration Rare',
      'Charizard ex 199/165 PSA 10 Pokemon 151',
    ];
    const parsed = parseSoldResults(soldHtml(titles.map((title, i) => ({ title, price: 600 + i, sold: 'Oct 2, 2026' }))));
    expect(parsed).toHaveLength(6);
    const s = await run(parsed);
    expect(s.matchedTitles).toEqual(titles.slice(4));
  });

  it('passes a clean title at the default 0.85 floor (title-only ceiling is 0.855)', async () => {
    const lk = await lookup();
    const { match } = await matchListing({ title: sale().title, aspects: {} }, lk);
    expect(match!.confidence).toBe(0.855);
    const s = await summarizeSales([sale()], { key, lookup: lk, minMatchConfidence: DEFAULT_SETTINGS.minMatchConfidence, now: NOW });
    expect(DEFAULT_SETTINGS.minMatchConfidence).toBe(0.85);
    expect(s.saleCount).toBe(1);
  });

  it('drops a low-confidence match (name not in title)', async () => {
    const s = await run([sale({ title: 'PSA 10 199/165 151 SIR' })]);
    expect(s.saleCount).toBe(0);
  });

  it('computes the median on odd and even counts', async () => {
    const odd = await run([500, 700, 600].map((price) => sale({ price })));
    expect(odd.median).toBe(600);
    const even = await run([500, 700, 600, 650].map((price) => sale({ price })));
    expect(even.median).toBe(625);
    expect(even.low).toBe(575);
    expect(even.high).toBe(662.5);
  });

  it('returns no_results for an empty page', async () => {
    expect(await run([])).toMatchObject({ status: 'no_results', saleCount: 0, matchedTitles: [] });
  });
});

describe('median and percentile', () => {
  it('interpolate linearly on sorted copies', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(percentile([10], 0.25)).toBe(10);
    expect(percentile([10, 20, 30, 40, 50], 0.25)).toBe(20);
    expect(percentile([10, 20, 30, 40, 50], 0.75)).toBe(40);
  });
});
