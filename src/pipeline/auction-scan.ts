import { loadChannels } from '../channels/channels.js';
import { listingOrigin } from '../listings/listings-repo.js';
import { loadSettings } from '../settings/settings.js';
import { AUX_MAIN_RESERVE_RATIO } from '../sources/ebay/aux-budget.js';
import type { Budget } from '../sources/ebay/budget.js';
import type { EbayClient } from '../sources/ebay/ebay-client.js';
import { summaryToListing } from '../sources/ebay/normalize.js';
import type { EvaluateDeps } from './evaluate.js';
import { ingestListing } from './ingest.js';
import type { ScanSummary } from './scan-cycle.js';

/** Auctions ending sooner than this are skipped: too late for a human to act. */
export const AUCTION_MIN_LEAD_MINUTES = 3;

export interface AuctionScanDeps extends EvaluateDeps {
  ebay: Pick<EbayClient, 'searchEndingAuctions' | 'getItem'>;
  budget: Budget;
}

export async function auctionScan(deps: AuctionScanDeps): Promise<ScanSummary> {
  const summary: ScanSummary = { status: 'ok', seen: 0, new: 0, missed: 0, errors: 0, outcomes: {} };
  const settings = await loadSettings(deps.db);
  if (settings.paused) return { ...summary, status: 'paused' };
  if (!settings.auctionMode) return { ...summary, status: 'disabled' };
  // Same line as aux calls: the main scan keeps priority.
  if ((await deps.budget.usedToday()) >= deps.budget.limit * AUX_MAIN_RESERVE_RATIO) return { ...summary, status: 'throttled' };

  const channels = await loadChannels(deps.db);
  const results = await deps.ebay.searchEndingAuctions(settings.auctionWindowMinutes);
  summary.seen = results.length;
  const cutoff = deps.now().getTime() + AUCTION_MIN_LEAD_MINUTES * 60_000;
  for (const s of results) {
    const listing = summaryToListing(s, { origin: 'auction' });
    if (!listing?.auction || listing.auction.endsAt.getTime() < cutoff) continue;
    const owner = await listingOrigin(deps.db, listing);
    if (owner !== null && owner !== 'auction') continue;
    await ingestListing(deps, listing, settings, channels, summary);
  }
  return summary;
}
