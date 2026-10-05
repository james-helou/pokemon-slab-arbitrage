import { describe, expect, it } from 'vitest';
import { buildCheckLinks } from '../../src/discord/check-links.js';

const base = { name: 'Charizard ex', number: '199', setName: '151', grader: 'PSA' as const, grade: 10 };

describe('buildCheckLinks', () => {
  it('builds an eBay sold link with the full query and sold/complete filters', () => {
    const links = buildCheckLinks(base);
    const ebay = links.find((l) => l.label === 'eBay sold')!;
    const u = new URL(ebay.url);
    expect(u.origin + u.pathname).toBe('https://www.ebay.com/sch/i.html');
    expect(u.searchParams.get('_nkw')).toBe('Charizard ex 199 PSA 10');
    expect(u.searchParams.get('LH_Sold')).toBe('1');
    expect(u.searchParams.get('LH_Complete')).toBe('1');
  });

  it('builds a PriceCharting search link on name and number', () => {
    const pc = buildCheckLinks(base).find((l) => l.label === 'PriceCharting')!;
    const u = new URL(pc.url);
    expect(u.origin + u.pathname).toBe('https://www.pricecharting.com/search-products');
    expect(u.searchParams.get('q')).toBe('Charizard ex 199');
    expect(u.searchParams.get('type')).toBe('prices');
  });

  it('builds a PSA auction prices link on name, number, grader and grade', () => {
    const psa = buildCheckLinks(base).find((l) => l.label === 'PSA APR')!;
    const u = new URL(psa.url);
    expect(u.origin + u.pathname).toBe('https://www.psacard.com/auctionprices/search');
    expect(u.searchParams.get('q')).toBe('Charizard ex 199 PSA 10');
    expect([...u.searchParams.keys()]).toEqual(['q']);
  });

  it('returns eBay sold, PriceCharting and PSA APR, all https', () => {
    const links = buildCheckLinks(base);
    expect(links.map((l) => l.label)).toEqual(['eBay sold', 'PriceCharting', 'PSA APR']);
    for (const l of links) expect(new URL(l.url).protocol).toBe('https:');
  });

  it('truncates long names by code points, never splitting a surrogate pair', () => {
    const name = `${'a'.repeat(79)}\u{1F525}tail`;
    const ebay = new URL(buildCheckLinks({ ...base, name })[0]!.url);
    const q = ebay.searchParams.get('_nkw')!;
    expect(q).toBe(`${'a'.repeat(79)}\u{1F525} 199 PSA 10`);
    expect(q).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('strips the printed total from the number', () => {
    const ebay = buildCheckLinks({ ...base, number: '199/165' })[0]!;
    expect(new URL(ebay.url).searchParams.get('_nkw')).toBe('Charizard ex 199 PSA 10');
    expect(ebay.url).not.toContain('165');
  });

  it('url-encodes &, apostrophes and accents', () => {
    const links = buildCheckLinks({ ...base, name: "Pokémon Trainer's Mew & Mewtwo", grade: 9.5, grader: 'BGS' });
    for (const l of links) {
      expect(l.url).not.toContain(' ');
      expect(l.url).not.toContain("'");
      expect(l.url).not.toContain('é');
    }
    const ebay = new URL(links[0]!.url);
    expect(ebay.searchParams.get('_nkw')).toBe("Pokémon Trainer's Mew & Mewtwo 199 BGS 9.5");
    expect([...ebay.searchParams.keys()]).toEqual(['_nkw', 'LH_Sold', 'LH_Complete']);
  });

  it('returns only https urls under 512 chars, at most 5', () => {
    const links = buildCheckLinks({ ...base, name: 'x'.repeat(2000) });
    expect(links.length).toBeGreaterThan(0);
    expect(links.length).toBeLessThanOrEqual(5);
    for (const l of links) {
      expect(new URL(l.url).protocol).toBe('https:');
      expect(l.url.length).toBeLessThan(512);
    }
  });
});
