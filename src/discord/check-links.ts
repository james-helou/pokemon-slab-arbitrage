import type { Grader } from '../domain/types.js';

export interface CheckLinkInput {
  name: string;
  number: string;
  setName: string;
  grader: Grader;
  grade: number;
}

export interface CheckLink {
  label: string;
  url: string;
}

const MAX_URL = 511;
const MAX_NAME = 80;

/** eBay sold + completed search for a free-text query (shared by the links, the sold check and its probe). */
export function ebaySoldSearchUrl(query: string): string {
  const u = new URL('https://www.ebay.com/sch/i.html');
  u.searchParams.set('_nkw', query);
  u.searchParams.set('LH_Sold', '1');
  u.searchParams.set('LH_Complete', '1');
  return u.toString();
}

/**
 * Manual price-check links for an alert. Patterns confirmed 2026-10-04:
 * - eBay sold: standard /sch/i.html search with LH_Sold=1&LH_Complete=1.
 * - PriceCharting: GET /search-products?q=&type=prices (the site's own search form).
 * - PSA APR: GET https://www.psacard.com/auctionprices/search?q=<name number grader grade>, confirmed from a
 *   secondary source. The site Cloudflare-challenges bots (humans pass), so it is a link only and never fetched.
 * 130point is still pending: its search URL pattern is unconfirmed.
 * PriceCharting gets name + number only; its product search does not understand grader/grade.
 */
export function buildCheckLinks(input: CheckLinkInput): CheckLink[] {
  const number = input.number.split('/')[0]!.trim();
  const build = (name: string): CheckLink[] => {
    const cardQuery = `${name} ${number}`.replace(/\s+/g, ' ').trim();
    const gradedQuery = `${cardQuery} ${input.grader} ${input.grade}`;
    const pc = new URL('https://www.pricecharting.com/search-products');
    pc.searchParams.set('q', cardQuery);
    pc.searchParams.set('type', 'prices');
    const psa = new URL('https://www.psacard.com/auctionprices/search');
    psa.searchParams.set('q', gradedQuery);
    return [
      { label: 'eBay sold', url: ebaySoldSearchUrl(gradedQuery) },
      { label: 'PriceCharting', url: pc.toString() },
      { label: 'PSA APR', url: psa.toString() },
    ];
  };
  // Code points, not UTF-16 units, so an emoji or astral character is never cut in half.
  const chars = Array.from(input.name.trim()).slice(0, MAX_NAME);
  let links = build(chars.join(''));
  while (chars.length > 0 && links.some((l) => l.url.length > MAX_URL)) {
    chars.pop();
    links = build(chars.join(''));
  }
  return links.filter((l) => l.url.length <= MAX_URL);
}
