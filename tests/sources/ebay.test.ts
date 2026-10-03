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
    expect(summaryToListing(SUMMARY)).toMatchObject({
      source: 'ebay', externalId: 'v1|111|0', price: 350, shipping: 5, sellerFeedbackScore: 500,
      sellerFeedbackPct: 99.8, aspects: {},
    });
  });

  it('merges item aspects', () => {
    const l = mergeItemDetails(summaryToListing(SUMMARY), ITEM);
    expect(l.aspects['Certification Number']).toBe('12345678');
  });

  it('detects out of stock', () => {
    expect(isOutOfStock(ITEM)).toBe(false);
    expect(isOutOfStock({ ...ITEM, estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'OUT_OF_STOCK' }] })).toBe(true);
  });
});
