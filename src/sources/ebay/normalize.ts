import type { Listing, ListingOrigin } from '../../domain/types.js';
import { round2 } from '../../scoring/fees.js';
import type { EbayItem, EbayItemSummary } from './ebay-client.js';

/**
 * Removes the seller username from an eBay payload before it is stored. We never persist eBay user data
 * (basis of the Marketplace Account Deletion exemption); feedback stats are kept for the risk check.
 */
function scrubSeller<T extends EbayItemSummary>(s: T): T {
  if (!s.seller) return s;
  const seller: Partial<NonNullable<EbayItemSummary['seller']>> = { ...s.seller };
  delete seller.username;
  return { ...s, seller: seller as EbayItemSummary['seller'] };
}

export interface NormalizeOpts {
  origin?: ListingOrigin;
  /** CAD -> USD rate; required to keep a CAD-priced listing. */
  cadToUsd?: number;
}

const finite = (v: string | undefined): number | null => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** Returns null (drop the listing) when the price is not a usable USD amount (or CAD with a rate), or an auction lacks a bid/end date. */
export function summaryToListing(s: EbayItemSummary, opts: NormalizeOpts = {}): Listing | null {
  const origin = opts.origin;
  let price: number;
  let originalPrice: number | null = null;
  let originalCurrency: 'CAD' | 'USD' = 'CAD';
  let auction: Listing['auction'] = null;
  let toUsd = (v: number): number => v;
  if (origin === 'auction') {
    const bid = s.currentBidPrice;
    const v = bid?.currency === 'USD' ? finite(bid.value) : null;
    const endsAt = s.itemEndDate ? new Date(s.itemEndDate) : null;
    if (v === null || v <= 0 || !endsAt || Number.isNaN(endsAt.getTime())) return null;
    price = v;
    auction = { currentBid: v, bidCount: s.bidCount ?? 0, endsAt };
  } else {
    const p = s.price;
    const v = p ? finite(p.value) : null;
    if (!p || v === null) return null;
    if (p.currency === 'CAD') {
      const rate = opts.cadToUsd;
      if (rate === undefined || !Number.isFinite(rate) || rate <= 0) return null;
      const seller = p.convertedFromCurrency === 'USD' ? finite(p.convertedFromValue) : null;
      price = seller ?? round2(v * rate);
      // The seller's own price: USD when they listed in USD (eBay's CAD figure is just a conversion).
      if (seller !== null) { originalPrice = seller; originalCurrency = 'USD'; } else originalPrice = v;
      toUsd = (x) => round2(x * rate);
    } else if (p.currency === 'USD') {
      price = v;
    } else {
      return null;
    }
  }
  const ship = s.shippingOptions?.[0]?.shippingCost;
  const shipValue = ship ? finite(ship.value) : null;
  const shipping = shipValue === null ? null : ship?.currency === 'CAD' ? toUsd(shipValue) : shipValue;
  return {
    source: 'ebay',
    externalId: s.itemId,
    title: s.title,
    price,
    shipping,
    currency: 'USD',
    url: s.itemWebUrl,
    imageUrl: s.image?.imageUrl ?? null,
    sellerUsername: null,
    sellerFeedbackScore: s.seller?.feedbackScore ?? null,
    sellerFeedbackPct: s.seller?.feedbackPercentage ? Number(s.seller.feedbackPercentage) : null,
    listedAt: s.itemCreationDate ? new Date(s.itemCreationDate) : null,
    aspects: {},
    raw: scrubSeller(s),
    ...(origin ? { origin } : {}),
    buyingOptions: Array.isArray(s.buyingOptions) ? s.buyingOptions.filter((o) => typeof o === 'string') : null,
    ...(originalPrice !== null ? { originalPrice, originalCurrency } : {}),
    ...(auction ? { auction } : {}),
  };
}

export function mergeItemDetails(listing: Listing, item: EbayItem, opts: NormalizeOpts = {}): Listing | null {
  const base = summaryToListing(item, { ...opts, ...(opts.origin ?? listing.origin ? { origin: (opts.origin ?? listing.origin)! } : {}) });
  if (!base) return null;
  const aspects: Record<string, string> = {};
  for (const a of item.localizedAspects ?? []) aspects[a.name] = a.value;
  return { ...base, listedAt: base.listedAt ?? listing.listedAt, aspects, raw: scrubSeller(item) };
}

/** The country the item ships from (eBay itemLocation.country on the stored summary or getItem body), or null. */
export function itemCountry(l: Pick<Listing, 'raw'>): string | null {
  const loc = (l.raw as { itemLocation?: { country?: unknown } } | null)?.itemLocation;
  return typeof loc?.country === 'string' ? loc.country : null;
}

export function isOutOfStock(item: EbayItem): boolean {
  return item.estimatedAvailabilities?.some((a) => a.estimatedAvailabilityStatus === 'OUT_OF_STOCK') ?? false;
}
