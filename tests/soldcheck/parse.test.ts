import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PARSER_VERSION, detectBlocked, parseSoldResults } from '../../src/soldcheck/parse.js';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/soldcheck/${name}`, import.meta.url), 'utf8');
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('parseSoldResults: s-item markup', () => {
  const sales = parseSoldResults(fixture('s-item.html'));

  it('skips the Shop on eBay placeholder, price ranges and non-USD prices', () => {
    expect(sales.map((s) => s.title)).toEqual([
      'PSA 10 Charizard ex 199/165 151 Special Illustration Rare',
      'Charizard ex 199/165 PSA 10 Pokemon 151',
      'Lot of 3 PSA 10 Charizard ex 199/165 151',
    ]);
  });

  it('parses price, currency and sold date and strips the New Listing tag', () => {
    expect(sales[0]).toEqual({
      title: 'PSA 10 Charizard ex 199/165 151 Special Illustration Rare', price: 612, currency: 'USD',
      soldAt: day('2026-10-02'), bestOfferAccepted: false, isLot: false,
    });
  });

  it('flags a struck-through Best offer accepted sale', () => {
    expect(sales[1]).toMatchObject({ price: 700, bestOfferAccepted: true, soldAt: day('2026-09-28') });
  });

  it('flags lots and parses thousands separators', () => {
    expect(sales[2]).toMatchObject({ price: 1850, isLot: true, bestOfferAccepted: false });
  });
});

describe('parseSoldResults: s-card markup', () => {
  const sales = parseSoldResults(fixture('s-card.html'));

  it('parses the newer card markup and drops the clipped screen-reader text', () => {
    expect(sales.map((s) => s.title)).toEqual([
      'PSA 10 Charizard ex 199/165 Pokemon 151 SIR',
      'Charizard ex 199 PSA 10 GEM MINT 151',
      'PSA 10 Charizard ex 199/165 151',
    ]);
    expect(sales[0]).toEqual({
      title: 'PSA 10 Charizard ex 199/165 Pokemon 151 SIR', price: 598.99, currency: 'USD',
      soldAt: day('2026-10-03'), bestOfferAccepted: false, isLot: false,
    });
  });

  it('flags Best Offer accepted and reads US $ prices', () => {
    expect(sales[1]).toMatchObject({ price: 650, bestOfferAccepted: true, soldAt: day('2026-09-30') });
    expect(sales[2]).toMatchObject({ price: 605, currency: 'USD', bestOfferAccepted: false });
  });
});

describe('parseSoldResults: edge cases', () => {
  it('returns [] for empty or unrelated html', () => {
    expect(parseSoldResults('')).toEqual([]);
    expect(parseSoldResults('<html><body><p>No exact matches found</p></body></html>')).toEqual([]);
  });

  it('keeps a sale with no sold caption as soldAt null', () => {
    const html = `<ul><li class="s-item"><div class="s-item__title">PSA 10 Charizard ex 199</div><span class="s-item__price">$600.00</span></li></ul>`;
    expect(parseSoldResults(html)).toEqual([
      { title: 'PSA 10 Charizard ex 199', price: 600, currency: 'USD', soldAt: null, bestOfferAccepted: false, isLot: false },
    ]);
  });

  it('is marked unverified until checked against a real page', () => {
    expect(PARSER_VERSION).toBe('v0-unverified');
  });
});

describe('detectBlocked', () => {
  it('treats 403 and 429 as blocked', () => {
    expect(detectBlocked('', 403)).toBe(true);
    expect(detectBlocked('<html></html>', 429)).toBe(true);
  });

  it('detects challenge and captcha pages on a 200', () => {
    expect(detectBlocked(fixture('challenge.html'), 200)).toBe(true);
    expect(detectBlocked('<p>Please verify you are a human</p>', 200)).toBe(true);
    expect(detectBlocked('<div class="g-recaptcha"></div>', 200)).toBe(true);
  });

  it('passes normal result pages', () => {
    expect(detectBlocked(fixture('s-item.html'), 200)).toBe(false);
    expect(detectBlocked(fixture('s-card.html'), 200)).toBe(false);
  });
});
