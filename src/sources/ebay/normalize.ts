import type { Listing } from '../../domain/types.js';
import type { EbayItem, EbayItemSummary } from './ebay-client.js';

export function summaryToListing(s: EbayItemSummary): Listing {
  return {
    source: 'ebay',
    externalId: s.itemId,
    title: s.title,
    price: Number(s.price.value),
    shipping: Number(s.shippingOptions?.[0]?.shippingCost?.value ?? 0),
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

export function mergeItemDetails(listing: Listing, item: EbayItem): Listing {
  const base = summaryToListing(item);
  const aspects: Record<string, string> = {};
  for (const a of item.localizedAspects ?? []) aspects[a.name] = a.value;
  return { ...base, listedAt: base.listedAt ?? listing.listedAt, aspects, raw: item };
}

export function isOutOfStock(item: EbayItem): boolean {
  return item.estimatedAvailabilities?.some((a) => a.estimatedAvailabilityStatus === 'OUT_OF_STOCK') ?? false;
}
