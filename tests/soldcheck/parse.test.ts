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

const item = (o: { title: string; price?: string; sold?: string; href?: string }) => `
  <li class="s-item">
    ${o.sold ? `<div class="s-item__caption"><span class="s-item__caption--signal POSITIVE"><span>${o.sold}</span></span></div>` : ''}
    ${o.href ? `<a class="s-item__link" href="${o.href}">` : ''}<div class="s-item__title"><span role="heading">${o.title}</span></div>${o.href ? '</a>' : ''}
    <span class="s-item__price"><span class="POSITIVE">${o.price ?? '$600.00'}</span></span>
  </li>`;
const page = (items: string) => `<html><body><ul class="srp-results">${items}</ul></body></html>`;

describe('parseSoldResults: lots', () => {
  it.each([
    'PSA 10 Charizard ex 199/165 151 x2',
    '2x PSA 10 Charizard ex 199/165 151',
    '3 x PSA 10 Charizard ex 199/165 151',
    'PSA 10 Charizard ex 199/165 151 X 3',
    'PSA 10 Charizard ex 199/165 151 Pair',
    'PSA 10 Charizard ex 199/165 151 duo',
    'Charizard ex 199/165 151 trio PSA 10',
    '3 PSA 10s Charizard ex 199/165 151',
    '2 CGC 9.5s Charizard ex 199/165 151',
    'Lot of 3 PSA 10 Charizard ex 199/165 151',
  ])('flags %s as a lot', (title) => {
    expect(parseSoldResults(page(item({ title, sold: 'Sold Oct 2, 2026' })))[0]!.isLot).toBe(true);
  });

  it.each([
    'PSA 10 Charizard ex 199/165 151 Special Illustration Rare',
    'Charizard ex 199/165 PSA 10 Pokemon 151',
    'PSA 10 Charizard ex 199/165 151 x1',
    'PSA 10 Mega Charizard X ex 013/094',
    'PSA 10 Charizard GX 9/68 Hidden Fates',
  ])('keeps %s as a single card', (title) => {
    expect(parseSoldResults(page(item({ title, sold: 'Sold Oct 2, 2026' })))[0]!.isLot).toBe(false);
  });
});

describe('parseSoldResults: dates', () => {
  const soldAt = (sold: string) => parseSoldResults(page(item({ title: 'PSA 10 Charizard ex 199', sold })))[0]!.soldAt;

  it('returns null on a rollover date', () => {
    expect(soldAt('Sold Feb 31, 2026')).toBeNull();
    expect(soldAt('Sold Apr 31, 2026')).toBeNull();
    expect(soldAt('Sold Feb 28, 2026')).toEqual(day('2026-02-28'));
  });

  it('accepts day-month-year captions', () => {
    expect(soldAt('Sold 2 Oct 2026')).toEqual(day('2026-10-02'));
    expect(soldAt('Sold 28 Sept. 2026')).toEqual(day('2026-09-28'));
    expect(soldAt('Sold 31 Feb 2026')).toBeNull();
  });
});

describe('parseSoldResults: scope and duplicates', () => {
  it('stops at the "Results matching fewer words" divider', () => {
    const html = page(
      item({ title: 'PSA 10 Charizard ex 199/165 A', sold: 'Sold Oct 2, 2026' })
      + '<li class="srp-river-answer srp-river-answer--REWRITE_START"><div>Results matching fewer words</div></li>'
      + item({ title: 'PSA 10 Charizard ex 199/165 B', sold: 'Sold Oct 1, 2026' }),
    );
    expect(parseSoldResults(html).map((s) => s.title)).toEqual(['PSA 10 Charizard ex 199/165 A']);
  });

  it('stops at a divider recognized only by its "fewer words" text', () => {
    const html = page(
      item({ title: 'PSA 10 Charizard ex 199/165 A', sold: 'Sold Oct 2, 2026' })
      + '<li class="srp-something-new"><h3>Results matching fewer words</h3></li>'
      + item({ title: 'PSA 10 Charizard ex 199/165 B', sold: 'Sold Oct 1, 2026' }),
    );
    expect(parseSoldResults(html).map((s) => s.title)).toEqual(['PSA 10 Charizard ex 199/165 A']);
  });

  it('dedupes by item id, ignoring tracking query strings', () => {
    const html = page(
      item({ title: 'PSA 10 Charizard ex 199/165 A', sold: 'Sold Oct 2, 2026', href: 'https://www.ebay.com/itm/555?hash=1' })
      + item({ title: 'PSA 10 Charizard ex 199/165 A (again)', sold: 'Sold Oct 2, 2026', href: 'https://www.ebay.com/itm/555?hash=2' })
      + item({ title: 'PSA 10 Charizard ex 199/165 A', sold: 'Sold Oct 2, 2026', href: 'https://www.ebay.com/itm/556' }),
    );
    expect(parseSoldResults(html)).toHaveLength(2);
  });

  it('dedupes by url when there is no item id', () => {
    const html = page(
      item({ title: 'PSA 10 Charizard ex 199/165 A', sold: 'Sold Oct 2, 2026', href: 'https://www.ebay.com/p/abc' })
      + item({ title: 'PSA 10 Charizard ex 199/165 B', sold: 'Sold Oct 1, 2026', href: 'https://www.ebay.com/p/abc' }),
    );
    expect(parseSoldResults(html)).toHaveLength(1);
  });

  it('falls back to title + price + date without a link', () => {
    const html = page(
      item({ title: 'PSA 10 Charizard ex 199/165 A', sold: 'Sold Oct 2, 2026' })
      + item({ title: 'PSA 10 Charizard ex 199/165 A', sold: 'Sold Oct 2, 2026' })
      + item({ title: 'PSA 10 Charizard ex 199/165 A', sold: 'Sold Oct 1, 2026' })
      + item({ title: 'PSA 10 Charizard ex 199/165 A', price: '$601.00', sold: 'Sold Oct 2, 2026' }),
    );
    expect(parseSoldResults(html)).toHaveLength(3);
  });
});

describe('detectBlocked', () => {
  it('treats 403 and 429 as blocked', () => {
    expect(detectBlocked('', 403)).toBe(true);
    expect(detectBlocked('<html></html>', 429)).toBe(true);
  });

  it('detects challenge pages on a 200 from the title or visible text', () => {
    expect(detectBlocked(fixture('challenge.html'), 200)).toBe(true);
    expect(detectBlocked('<p>Please verify you are a human</p>', 200)).toBe(true);
    expect(detectBlocked('<html><head><title>Just a moment...</title></head><body></body></html>', 200)).toBe(true);
    expect(detectBlocked('<p>Checking your browser before accessing ebay.com</p>', 200)).toBe(true);
  });

  it('counts a captcha form only with visible captcha text and no results', () => {
    expect(detectBlocked('<div class="g-recaptcha"></div>', 200)).toBe(false);
    expect(detectBlocked('<div class="g-recaptcha"><p>Please complete the captcha</p></div>', 200)).toBe(true);
  });

  it('passes normal result pages', () => {
    expect(detectBlocked(fixture('s-item.html'), 200)).toBe(false);
    expect(detectBlocked(fixture('s-card.html'), 200)).toBe(false);
  });

  it('ignores challenge words inside scripts, styles and noscript on a results page', () => {
    const html = fixture('s-item.html').replace(
      '</body>',
      '<script>var x="recaptcha"; var y="Pardon Our Interruption";</script><style>.captcha{}</style>'
        + '<noscript>verify you are a human</noscript></body>',
    );
    expect(detectBlocked(html, 200)).toBe(false);
    expect(detectBlocked('<html><body><script>var x="recaptcha"</script><p>0 results</p></body></html>', 200)).toBe(false);
  });

  it('never calls a page with real results blocked, even if challenge text is visible', () => {
    const html = fixture('s-item.html').replace('</body>', '<p>Pardon Our Interruption</p></body>');
    expect(detectBlocked(html, 200)).toBe(false);
  });

  it('treats an empty results page with no challenge text as not blocked (no_results)', () => {
    expect(detectBlocked('<html><head><title>charizard | eBay</title></head><body><h1>0 results for charizard</h1>'
      + '<ul class="srp-results"></ul></body></html>', 200)).toBe(false);
  });
});
