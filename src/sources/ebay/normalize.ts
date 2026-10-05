import type { Listing } from '../../domain/types.js';
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

/** Returns null (drop the listing) when the price is not finite USD. */
export function summaryToListing(s: EbayItemSummary): Listing | null {
  const price = Number(s.price.value);
  if (s.price.currency !== 'USD' || !Number.isFinite(price)) return null;
  const ship = s.shippingOptions?.[0]?.shippingCost;
  const shipping = ship && Number.isFinite(Number(ship.value)) && ship.value !== '' ? Number(ship.value) : null;
  return {
    source: 'ebay',
    externalId: s.itemId,
    title: s.title,
    price,
    shipping,
    currency: s.price.currency,
    url: s.itemWebUrl,
    imageUrl: s.image?.imageUrl ?? null,
    sellerUsername: null,
    sellerFeedbackScore: s.seller?.feedbackScore ?? null,
    sellerFeedbackPct: s.seller?.feedbackPercentage ? Number(s.seller.feedbackPercentage) : null,
    listedAt: s.itemCreationDate ? new Date(s.itemCreationDate) : null,
    aspects: {},
    raw: scrubSeller(s),
  };
}

export function mergeItemDetails(listing: Listing, item: EbayItem): Listing | null {
  const base = summaryToListing(item);
  if (!base) return null;
  const aspects: Record<string, string> = {};
  for (const a of item.localizedAspects ?? []) aspects[a.name] = a.value;
  return { ...base, listedAt: base.listedAt ?? listing.listedAt, aspects, raw: scrubSeller(item) };
}

export function isOutOfStock(item: EbayItem): boolean {
  return item.estimatedAvailabilities?.some((a) => a.estimatedAvailabilityStatus === 'OUT_OF_STOCK') ?? false;
}
