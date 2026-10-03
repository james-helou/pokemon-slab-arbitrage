import type { Listing } from '../../domain/types.js';
import type { EbayItem, EbayItemSummary } from './ebay-client.js';

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
    sellerUsername: s.seller?.username ?? null,
    sellerFeedbackScore: s.seller?.feedbackScore ?? null,
    sellerFeedbackPct: s.seller?.feedbackPercentage ? Number(s.seller.feedbackPercentage) : null,
    listedAt: s.itemCreationDate ? new Date(s.itemCreationDate) : null,
    aspects: {},
    raw: s,
  };
}

export function mergeItemDetails(listing: Listing, item: EbayItem): Listing | null {
  const base = summaryToListing(item);
  if (!base) return null;
  const aspects: Record<string, string> = {};
  for (const a of item.localizedAspects ?? []) aspects[a.name] = a.value;
  return { ...base, listedAt: base.listedAt ?? listing.listedAt, aspects, raw: item };
}

export function isOutOfStock(item: EbayItem): boolean {
  return item.estimatedAvailabilities?.some((a) => a.estimatedAvailabilityStatus === 'OUT_OF_STOCK') ?? false;
}
