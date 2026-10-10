import { describe, expect, it } from 'vitest';
import { BudgetExceededError, createBudget, type Budget } from '../../src/sources/ebay/budget.js';
import { createEbayClient, type EbayItemSummary } from '../../src/sources/ebay/ebay-client.js';
import { isOutOfStock, mergeItemDetails, summaryToListing } from '../../src/sources/ebay/normalize.js';
import { createTestDb } from '../helpers/test-db.js';
import { ITEM, SUMMARY } from '../helpers/fixtures.js';

const NOW = new Date('2026-10-03T12:00:00Z');

function fakeEbayFetch(routes: { search?: unknown; item?: Response }) {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    if (url.includes('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }));
    if (url.includes('/item_summary/search')) return new Response(JSON.stringify(routes.search ?? {}));
    return routes.item ?? new Response(JSON.stringify(ITEM));
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const noBudget: Budget = { limit: 5000, beforeCall: async () => {}, usedToday: async () => 0 };

function client(fetchFn: typeof fetch, budget: Budget = noBudget, buyerLocation?: { country: string; postalCode?: string }) {
  return createEbayClient({
    clientId: 'id', clientSecret: 'secret', fetchFn, now: () => NOW,
    categoryIds: '183454', query: 'pokemon', minPrice: 25, budget,
    ...(buyerLocation ? { buyerLocation } : {}),
  });
}

/** Records the headers of every non-token request alongside the url. */
function recordingFetch() {
  const reqs: { url: string; headers: Record<string, string> }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    if (url.includes('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }));
    reqs.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    if (url.includes('/item_summary/search')) return new Response(JSON.stringify({ itemSummaries: [SUMMARY] }));
    return new Response(JSON.stringify(ITEM));
  }) as unknown as typeof fetch;
  return { fn, reqs };
}

describe('eBay client', () => {
  it('searches newest graded BIN and caches the token', async () => {
    const f = fakeEbayFetch({ search: { itemSummaries: [SUMMARY] } });
    const c = client(f.fn);
    expect(await c.searchNewGraded()).toHaveLength(1);
    await c.searchNewGraded();
    expect(f.calls.filter((u) => u.includes('oauth2')).length).toBe(1);
    const search = new URL(f.calls.find((u) => u.includes('/search'))!);
    expect(search.searchParams.get('sort')).toBe('newlyListed');
    expect(search.searchParams.get('filter')).toBe(
      'buyingOptions:{FIXED_PRICE},conditionIds:{2750},price:[25..],priceCurrency:USD',
    );
  });

  it('adds the encoded buyer-location header and deliveryCountry filter on search and getItem', async () => {
    const f = recordingFetch();
    const c = client(f.fn, noBudget, { country: 'CA', postalCode: 'H7T2W7' });
    await c.searchNewGraded();
    await c.getItem('v1|111|0');
    const expected = `contextualLocation=${encodeURIComponent('country=CA,zip=H7T2W7')}`;
    expect(expected).toBe('contextualLocation=country%3DCA%2Czip%3DH7T2W7');
    expect(f.reqs).toHaveLength(2);
    for (const r of f.reqs) {
      expect(r.headers['X-EBAY-C-ENDUSERCTX']).toBe(expected);
      expect(r.headers['X-EBAY-C-MARKETPLACE-ID']).toBe('EBAY_US');
    }
    const filter = new URL(f.reqs[0]!.url).searchParams.get('filter');
    expect(filter).toBe(
      'buyingOptions:{FIXED_PRICE},conditionIds:{2750},price:[25..],priceCurrency:USD,deliveryCountry:CA',
    );
  });

  it('omits the zip from the header when the buyer has no postal code', async () => {
    const f = recordingFetch();
    await client(f.fn, noBudget, { country: 'CA' }).getItem('v1|111|0');
    expect(f.reqs[0]!.headers['X-EBAY-C-ENDUSERCTX']).toBe('contextualLocation=country%3DCA');
  });

  it('sends no location header and no deliveryCountry filter when unset', async () => {
    const f = recordingFetch();
    const c = client(f.fn);
    await c.searchNewGraded();
    await c.getItem('v1|111|0');
    for (const r of f.reqs) {
      expect(Object.keys(r.headers).sort()).toEqual(['Authorization', 'X-EBAY-C-MARKETPLACE-ID']);
    }
    expect(new URL(f.reqs[0]!.url).searchParams.get('filter')).not.toContain('deliveryCountry');
  });

  it('searches auctions ending soon with no price floor, soonest first', async () => {
    const f = recordingFetch();
    const c = client(f.fn, noBudget, { country: 'CA' });
    await c.searchEndingAuctions(60);
    const u = new URL(f.reqs[0]!.url);
    expect(u.searchParams.get('filter')).toBe(
      'buyingOptions:{AUCTION},conditionIds:{2750},itemEndDate:[..2026-10-03T13:00:00.000Z],priceCurrency:USD,deliveryCountry:CA',
    );
    expect(u.searchParams.get('filter')).not.toContain('price:[');
    expect(u.searchParams.get('sort')).toBe('endingSoonest');
    expect(u.searchParams.get('limit')).toBe('200');
    expect(u.searchParams.get('q')).toBe('pokemon');
    expect(u.searchParams.get('category_ids')).toBe('183454');
    expect(f.reqs[0]!.headers['X-EBAY-C-MARKETPLACE-ID']).toBe('EBAY_US');
  });

  it('CA client uses EBAY_CA on search and getItem with a CAD, CA-located filter', async () => {
    const f = recordingFetch();
    const c = createEbayClient({
      clientId: 'id', clientSecret: 'secret', fetchFn: f.fn, now: () => NOW, categoryIds: '183454', query: 'pokemon',
      minPrice: 25, budget: noBudget, buyerLocation: { country: 'CA' }, marketplaceId: 'EBAY_CA', itemLocationCountry: 'CA',
    });
    await c.searchNewGraded();
    await c.getItem('v1|111|0');
    expect(f.reqs.map((r) => r.headers['X-EBAY-C-MARKETPLACE-ID'])).toEqual(['EBAY_CA', 'EBAY_CA']);
    expect(new URL(f.reqs[0]!.url).searchParams.get('filter')).toBe(
      'buyingOptions:{FIXED_PRICE},conditionIds:{2750},price:[25..],priceCurrency:CAD,itemLocationCountry:CA,deliveryCountry:CA',
    );
  });

  it('counts auction searches against the budget', async () => {
    let n = 0;
    const budget: Budget = { limit: 5000, beforeCall: async () => { n++; }, usedToday: async () => n };
    await client(fakeEbayFetch({ search: {} }).fn, budget).searchEndingAuctions(60);
    expect(n).toBe(1);
  });

  it('returns an empty array when no summaries', async () => {
    expect(await client(fakeEbayFetch({ search: {} }).fn).searchNewGraded()).toEqual([]);
  });

  it('returns null for a 404 item', async () => {
    const f = fakeEbayFetch({ item: new Response('not found', { status: 404 }) });
    expect(await client(f.fn).getItem('v1|111|0')).toBeNull();
  });

  it('clears the token and retries once on 401', async () => {
    let tokens = 0;
    let searches = 0;
    const fn = (async (url: string) => {
      if (url.includes('/oauth2/token')) {
        tokens++;
        return new Response(JSON.stringify({ access_token: `tok${tokens}`, expires_in: 7200 }));
      }
      searches++;
      return searches === 1 ? new Response('no', { status: 401 }) : new Response(JSON.stringify({ itemSummaries: [SUMMARY] }));
    }) as unknown as typeof fetch;
    expect(await client(fn).searchNewGraded()).toHaveLength(1);
    expect(tokens).toBe(2);
    expect(searches).toBe(2);
  });

  it('counts each API call against the budget (not the token call)', async () => {
    let n = 0;
    const budget: Budget = { limit: 5000, beforeCall: async () => { n++; }, usedToday: async () => n };
    const c = client(fakeEbayFetch({ search: {} }).fn, budget);
    await c.searchNewGraded();
    await c.getItem('v1|111|0');
    expect(n).toBe(2);
  });
});

describe('budget', () => {
  it('throws once the daily limit is exceeded', async () => {
    const db = await createTestDb();
    const b = createBudget(db, 'ebay_browse', 2, () => NOW);
    await b.beforeCall();
    await b.beforeCall();
    await expect(b.beforeCall()).rejects.toBeInstanceOf(BudgetExceededError);
    expect(await b.usedToday()).toBe(3);
  });
});

describe('normalize', () => {
  it('maps a summary to a Listing', () => {
    expect(summaryToListing(SUMMARY)!).toMatchObject({
      source: 'ebay', externalId: 'v1|111|0', price: 350, shipping: 5, sellerFeedbackScore: 500,
      sellerFeedbackPct: 99.8, aspects: {},
    });
  });

  it('uses null shipping when eBay gives no shipping cost', () => {
    expect(summaryToListing({ ...SUMMARY, shippingOptions: [{}] })?.shipping).toBeNull();
    expect(summaryToListing({ ...SUMMARY, shippingOptions: undefined })?.shipping).toBeNull();
    expect(summaryToListing({ ...SUMMARY, shippingOptions: [{ shippingCost: { value: '0.00', currency: 'USD' } }] })?.shipping).toBe(0);
  });

  it('drops non-USD and non-finite prices', () => {
    expect(summaryToListing({ ...SUMMARY, price: { value: '350.00', currency: 'EUR' } })).toBeNull();
    expect(summaryToListing({ ...SUMMARY, price: { value: 'abc', currency: 'USD' } })).toBeNull();
  });

  it('merges item aspects', () => {
    const l = mergeItemDetails(summaryToListing(SUMMARY)!, ITEM);
    expect(l!.aspects['Certification Number']).toBe('12345678');
    expect(mergeItemDetails(summaryToListing(SUMMARY)!, { ...ITEM, price: { value: '1', currency: 'EUR' } })).toBeNull();
  });

  it('detects out of stock', () => {
    expect(isOutOfStock(ITEM)).toBe(false);
    expect(isOutOfStock({ ...ITEM, estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'OUT_OF_STOCK' }] })).toBe(true);
  });
});

describe('normalize: no eBay user data persisted', () => {
  const withSeller = { ...SUMMARY, seller: { username: 'someseller', feedbackScore: 500, feedbackPercentage: '99.5' } };

  it('drops the seller username from the listing and its raw payload, keeps feedback stats', () => {
    const l = summaryToListing(withSeller)!;
    expect(l.sellerUsername).toBeNull();
    expect(l.sellerFeedbackScore).toBe(500);
    expect(l.sellerFeedbackPct).toBe(99.5);
    expect(JSON.stringify(l.raw)).not.toContain('someseller');
  });

  it('drops the seller username from getItem details too', () => {
    const base = summaryToListing(withSeller)!;
    const merged = mergeItemDetails(base, { ...ITEM, seller: { username: 'someseller', feedbackScore: 500 } })!;
    expect(merged.sellerUsername).toBeNull();
    expect(JSON.stringify(merged.raw)).not.toContain('someseller');
  });
});

describe('eBay.ca shapes', () => {
  // Observed in production (EBAY_CA, CA-located): ids are identical across marketplaces.
  const caSummary: EbayItemSummary = {
    ...SUMMARY, itemId: 'v1|147629684283|0', legacyItemId: '147629684283',
    itemWebUrl: 'https://www.ebay.ca/itm/147629684283?_skw=pokemon+psa&hash=item225f6a363b:g:2zkAAeSwjuZqyoM6',
    price: { value: '600.00', currency: 'CAD' },
    shippingOptions: [{ shippingCostType: 'FIXED', shippingCost: { value: '12.50', currency: 'CAD' } }],
    buyingOptions: ['FIXED_PRICE', 'BEST_OFFER'],
  };

  it('converts a CAD summary to USD and keeps the original', () => {
    const l = summaryToListing(caSummary, { origin: 'ca_bin', cadToUsd: 1 / 1.4 })!;
    expect(l).toMatchObject({
      externalId: 'v1|147629684283|0', price: 428.57, shipping: 8.93, originalPrice: 600, originalCurrency: 'CAD', origin: 'ca_bin',
    });
    expect(l.url).toContain('ebay.ca');
  });

  it('treats a USD price converted from CAD (US scan seeing a CA item) as plain USD', () => {
    const us: EbayItemSummary = {
      ...caSummary, itemWebUrl: 'https://www.ebay.com/itm/147629684283',
      price: { value: '420.85', currency: 'USD', convertedFromValue: '600.00', convertedFromCurrency: 'CAD' },
      shippingOptions: [{ shippingCostType: 'FIXED', shippingCost: { value: '8.77', currency: 'USD', convertedFromValue: '12.50', convertedFromCurrency: 'CAD' } }],
    };
    const l = summaryToListing(us)!;
    expect(l).toMatchObject({ price: 420.85, shipping: 8.77, currency: 'USD' });
    expect(l.originalPrice).toBeUndefined();
  });
});

describe('deal-mode normalization', () => {
  const auction = (over: Partial<EbayItemSummary> = {}): EbayItemSummary => ({
    ...SUMMARY, price: undefined, currentBidPrice: { value: '200.00', currency: 'USD' }, bidCount: 4,
    itemEndDate: '2026-10-03T12:30:00.000Z', buyingOptions: ['AUCTION'], ...over,
  });

  it('copies buyingOptions and leaves USD output unchanged', () => {
    const l = summaryToListing({ ...SUMMARY, buyingOptions: ['FIXED_PRICE', 'BEST_OFFER'] })!;
    expect(l.buyingOptions).toEqual(['FIXED_PRICE', 'BEST_OFFER']);
    expect(summaryToListing(SUMMARY)!.buyingOptions).toBeNull();
    expect(summaryToListing(SUMMARY)!.price).toBe(350);
  });

  it('auction: current bid becomes the price and endsAt is kept', () => {
    const l = summaryToListing(auction(), { origin: 'auction' })!;
    expect(l.price).toBe(200);
    expect(l.origin).toBe('auction');
    expect(l.auction).toEqual({ currentBid: 200, bidCount: 4, endsAt: new Date('2026-10-03T12:30:00.000Z') });
    expect(summaryToListing(auction({ bidCount: undefined }), { origin: 'auction' })!.auction!.bidCount).toBe(0);
  });

  it('auction: drops listings without a usable bid or end date', () => {
    expect(summaryToListing(auction({ itemEndDate: undefined }), { origin: 'auction' })).toBeNull();
    expect(summaryToListing(auction({ itemEndDate: 'garbage' }), { origin: 'auction' })).toBeNull();
    expect(summaryToListing(auction({ currentBidPrice: { value: '200', currency: 'CAD' } }), { origin: 'auction' })).toBeNull();
    expect(summaryToListing(auction({ currentBidPrice: { value: '0', currency: 'USD' } }), { origin: 'auction' })).toBeNull();
    expect(summaryToListing(auction({ currentBidPrice: undefined }), { origin: 'auction' })).toBeNull();
  });

  it('CAD: converts price and shipping, keeps the original price', () => {
    const cad: EbayItemSummary = {
      ...SUMMARY, price: { value: '630.00', currency: 'CAD' },
      shippingOptions: [{ shippingCost: { value: '14.00', currency: 'CAD' } }],
    };
    const l = summaryToListing(cad, { origin: 'ca_bin', cadToUsd: 1 / 1.4 })!;
    expect(l).toMatchObject({ price: 450, shipping: 10, currency: 'USD', originalPrice: 630, originalCurrency: 'CAD', origin: 'ca_bin' });
  });

  it('CAD: uses convertedFromValue when the seller listed in USD, and drops without a rate', () => {
    const cad: EbayItemSummary = {
      ...SUMMARY, price: { value: '490.00', currency: 'CAD', convertedFromValue: '350.00', convertedFromCurrency: 'USD' },
    };
    const l = summaryToListing(cad, { origin: 'ca_bin', cadToUsd: 0.7 })!;
    expect(l.price).toBe(350);
    expect(l).toMatchObject({ originalPrice: 350, originalCurrency: 'USD' });
    expect(summaryToListing(cad, { origin: 'ca_bin' })).toBeNull();
    expect(summaryToListing(cad)).toBeNull();
  });

  it('mergeItemDetails carries origin, auction and CAD fields', () => {
    const listing = summaryToListing(auction(), { origin: 'auction' })!;
    const merged = mergeItemDetails(listing, { ...ITEM, ...auction() }, { origin: 'auction' })!;
    expect(merged.origin).toBe('auction');
    expect(merged.auction?.currentBid).toBe(200);
    expect(merged.aspects['Grade']).toBe('10');
  });
});
