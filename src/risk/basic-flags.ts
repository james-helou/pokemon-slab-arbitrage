import type { Listing, Match, RedFlag } from '../domain/types.js';

export function basicRedFlags(listing: Listing, match: Match): RedFlag[] {
  const flags: RedFlag[] = [];
  if (!match.cert) flags.push({ code: 'no_cert', blocking: false, confidencePenalty: 0.2 });
  if (listing.sellerFeedbackScore !== null && listing.sellerFeedbackScore < 10) {
    flags.push({ code: 'new_seller', blocking: false, confidencePenalty: 0.3 });
  }
  return flags;
}
