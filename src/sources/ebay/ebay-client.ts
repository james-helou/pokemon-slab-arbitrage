import type { Budget } from './budget.js';

const API = 'https://api.ebay.com';

export interface Money {
  value: string;
  currency: string;
}

export interface EbayItemSummary {
  itemId: string;
  title: string;
  price: Money;
  shippingOptions?: { shippingCost?: Money }[];
  itemWebUrl: string;
  image?: { imageUrl: string };
  seller?: { username: string; feedbackScore?: number; feedbackPercentage?: string };
  itemCreationDate?: string;
}

export interface EbayItem extends EbayItemSummary {
  localizedAspects?: { name: string; value: string }[];
  estimatedAvailabilities?: { estimatedAvailabilityStatus?: string }[];
}

export interface EbayClient {
  searchNewGraded(): Promise<EbayItemSummary[]>;
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

  async function get(path: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      await o.budget.beforeCall();
      const res = await o.fetchFn(`${API}${path}`, {
        headers: { Authorization: `Bearer ${await getToken()}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' },
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
        filter: `buyingOptions:{FIXED_PRICE},conditionIds:{2750},price:[${o.minPrice}..],priceCurrency:USD`,
        sort: 'newlyListed',
        limit: '200',
      });
      const res = await get(`/buy/browse/v1/item_summary/search?${params.toString()}`);
      if (!res.ok) throw new Error(`eBay search ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { itemSummaries?: EbayItemSummary[] };
      return body.itemSummaries ?? [];
    },
    async getItem(itemId) {
      const res = await get(`/buy/browse/v1/item/${encodeURIComponent(itemId)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`eBay getItem ${res.status}: ${await res.text()}`);
      return (await res.json()) as EbayItem;
    },
  };
}
