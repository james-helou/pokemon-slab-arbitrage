import { describe, expect, it } from 'vitest';
import { BudgetExceededError, createBudget, type Budget } from '../../src/sources/ebay/budget.js';
import { createEbayClient } from '../../src/sources/ebay/ebay-client.js';
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

function client(fetchFn: typeof fetch, budget: Budget = noBudget) {
  return createEbayClient({
    clientId: 'id', clientSecret: 'secret', fetchFn, now: () => NOW,
    categoryIds: '183454', query: 'pokemon', minPrice: 25, budget,
  });
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
