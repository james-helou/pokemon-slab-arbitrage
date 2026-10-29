import type { Budget } from './budget.js';

const API = 'https://api.ebay.com';
const PAGE_SIZE = 200;

export interface Money {
  value: string;
  currency: string;
  convertedFromValue?: string;
  convertedFromCurrency?: string;
}

export interface EbayItemSummary {
  itemId: string;
  title: string;
  price?: Money;
  currentBidPrice?: Money;
  bidCount?: number;
  itemEndDate?: string;
  buyingOptions?: string[];
  legacyItemId?: string;
  shippingOptions?: { shippingCost?: Money; shippingCostType?: string }[];
  itemWebUrl: string;
  image?: { imageUrl: string };
  seller?: { username: string; feedbackScore?: number; feedbackPercentage?: string };
  itemCreationDate?: string;
}

export interface EbayItem extends EbayItemSummary {
  /** Auctions with a reserve only: false while the high bid is below it. */
  reservePriceMet?: boolean;
  localizedAspects?: { name: string; value: string }[];
  estimatedAvailabilities?: { estimatedAvailabilityStatus?: string }[];
}

export interface LiveAuctionSearch {
  items: EbayItemSummary[];
  /** false when a later page failed and only the earlier pages are in items. */
  complete: boolean;
}

export interface EbayClient {
  searchNewGraded(): Promise<EbayItemSummary[]>;
  /** Auctions ending within windowMinutes, soonest first. No price floor: it would apply to the current bid. */
  searchEndingAuctions(windowMinutes: number): Promise<EbayItemSummary[]>;
  /**
   * Live auctions with a current bid >= minBid ending within windowHours, ending soonest first, up to maxPages x 200.
   * Throws when the first page fails; a later page failing (non-OK, BudgetExceededError, network) keeps what was
   * collected, complete: false.
   */
  searchLiveAuctions(o: { windowHours: number; minBid: number; maxPages: number }): Promise<LiveAuctionSearch>;
  getItem(itemId: string): Promise<EbayItem | null>;
}

export interface EbayClientOptions {
  clientId: string;
  clientSecret: string;
  fetchFn: typeof fetch;
  now: () => Date;
  categoryIds: string;
  query: string;
  minPrice: number;
  budget: Budget;
  /** When set, eBay quotes shipping to this location and the search keeps only listings that ship to its country. */
  buyerLocation?: { country: string; postalCode?: string };
  /** Default EBAY_US. EBAY_CA quotes prices and shipping in CAD. */
  marketplaceId?: 'EBAY_US' | 'EBAY_CA';
  /** Keeps only listings located in this country (search filter itemLocationCountry). */
  itemLocationCountry?: string;
}

export function createEbayClient(o: EbayClientOptions): EbayClient {
  let token: { value: string; expiresAt: number } | null = null;

  async function getToken(): Promise<string> {
    if (token && token.expiresAt > o.now().getTime() + 60_000) return token.value;
    const res = await o.fetchFn(`${API}/identity/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${o.clientId}:${o.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'https://api.ebay.com/oauth/api_scope',
      }).toString(),
    });
    if (!res.ok) throw new Error(`eBay token ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    token = { value: body.access_token, expiresAt: o.now().getTime() + body.expires_in * 1000 };
    return token.value;
  }

  const endUserCtx = o.buyerLocation
    ? `contextualLocation=${encodeURIComponent(
        `country=${o.buyerLocation.country}${o.buyerLocation.postalCode ? `,zip=${o.buyerLocation.postalCode}` : ''}`,
      )}`
    : undefined;

  async function get(path: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      await o.budget.beforeCall();
      const res = await o.fetchFn(`${API}${path}`, {
        headers: {
          Authorization: `Bearer ${await getToken()}`,
          'X-EBAY-C-MARKETPLACE-ID': o.marketplaceId ?? 'EBAY_US',
          ...(endUserCtx ? { 'X-EBAY-C-ENDUSERCTX': endUserCtx } : {}),
        },
      });
      if (res.status !== 401 || attempt >= 1) return res;
      token = null;
    }
  }

  return {
    async searchNewGraded() {
      const params = new URLSearchParams({
        q: o.query,
        category_ids: o.categoryIds,
        filter: `buyingOptions:{FIXED_PRICE},conditionIds:{2750},price:[${o.minPrice}..],priceCurrency:${o.marketplaceId === 'EBAY_CA' ? 'CAD' : 'USD'}${o.itemLocationCountry ? `,itemLocationCountry:${o.itemLocationCountry}` : ''}${o.buyerLocation ? `,deliveryCountry:${o.buyerLocation.country}` : ''}`,
        sort: 'newlyListed',
        limit: '200',
      });
      const res = await get(`/buy/browse/v1/item_summary/search?${params.toString()}`);
      if (!res.ok) throw new Error(`eBay search ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { itemSummaries?: EbayItemSummary[] };
      return body.itemSummaries ?? [];
    },
    async searchEndingAuctions(windowMinutes) {
      const endBy = new Date(o.now().getTime() + windowMinutes * 60_000).toISOString();
      const params = new URLSearchParams({
        q: o.query,
        category_ids: o.categoryIds,
        filter: `buyingOptions:{AUCTION},conditionIds:{2750},itemEndDate:[..${endBy}],priceCurrency:USD${o.buyerLocation ? `,deliveryCountry:${o.buyerLocation.country}` : ''}`,
        sort: 'endingSoonest',
        limit: '200',
      });
      const res = await get(`/buy/browse/v1/item_summary/search?${params.toString()}`);
      if (!res.ok) throw new Error(`eBay auction search ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { itemSummaries?: EbayItemSummary[] };
      return body.itemSummaries ?? [];
    },
    async searchLiveAuctions({ windowHours, minBid, maxPages }) {
      const endBy = new Date(o.now().getTime() + windowHours * 3_600_000).toISOString();
      const out: EbayItemSummary[] = [];
      for (let page = 0; page < maxPages; page++) {
        const params = new URLSearchParams({
          q: o.query,
          category_ids: o.categoryIds,
          filter: `buyingOptions:{AUCTION},conditionIds:{2750},price:[${minBid}..],priceCurrency:USD,itemEndDate:[..${endBy}]${o.buyerLocation ? `,deliveryCountry:${o.buyerLocation.country}` : ''}`,
          sort: 'endingSoonest',
          limit: String(PAGE_SIZE),
          offset: String(page * PAGE_SIZE),
        });
        let items: EbayItemSummary[];
        try {
          const res = await get(`/buy/browse/v1/item_summary/search?${params.toString()}`);
          if (!res.ok) throw new Error(`eBay live auction search ${res.status}: ${await res.text()}`);
          items = ((await res.json()) as { itemSummaries?: EbayItemSummary[] }).itemSummaries ?? [];
        } catch (err) {
          // Page 0 failing is a failed search; any later page failure (non-OK, budget, network) keeps what the
          // earlier pages found.
          if (page === 0) throw err;
          return { items: out, complete: false };
        }
        out.push(...items);
        if (items.length < PAGE_SIZE) break;
      }
      return { items: out, complete: true };
    },
    async getItem(itemId) {
      const res = await get(`/buy/browse/v1/item/${encodeURIComponent(itemId)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`eBay getItem ${res.status}: ${await res.text()}`);
      return (await res.json()) as EbayItem;
    },
  };
}
