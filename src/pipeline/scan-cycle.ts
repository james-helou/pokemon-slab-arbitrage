import { loadChannels } from '../channels/channels.js';
import {
  markEvaluated, needsEvaluation, recordEvalFailure, recordWindowMisses, upsertListing,
} from '../listings/listings-repo.js';
import { loadSettings } from '../settings/settings.js';
import type { Budget } from '../sources/ebay/budget.js';
import type { EbayClient } from '../sources/ebay/ebay-client.js';
import { summaryToListing } from '../sources/ebay/normalize.js';
import { evaluateListing, type EvaluateDeps } from './evaluate.js';

export interface ScanDeps extends EvaluateDeps {
  ebay: EbayClient;
  budget: Budget;
}

export interface ScanSummary {
  status: 'ok' | 'paused' | 'throttled';
  seen: number;
  new: number;
  /** Open listings inside this scan's window that the scan did not return (disappearance suspects accrue here). */
  missed: number;
  errors: number;
  outcomes: Record<string, number>;
}

export async function scanCycle(deps: ScanDeps, cycle: number): Promise<ScanSummary> {
  const summary: ScanSummary = { status: 'ok', seen: 0, new: 0, missed: 0, errors: 0, outcomes: {} };
  const settings = await loadSettings(deps.db);
  if (settings.paused) return { ...summary, status: 'paused' };
  if ((await deps.budget.usedToday()) >= deps.budget.limit * 0.9 && cycle % 2 === 1) {
    return { ...summary, status: 'throttled' };
  }

  const channels = await loadChannels(deps.db);
  const results = await deps.ebay.searchNewGraded();
  summary.seen = results.length;
  const seenIds: string[] = [];
  let windowFloor: Date | null = null;
  for (const s of results) {
    // FIXED_PRICE+AUCTION items belong to the auction scan (the BIN option disappears after the first bid).
    if (settings.auctionMode && s.buyingOptions?.includes('AUCTION')) continue;
    const listing = summaryToListing(s);
    if (!listing) continue;
    seenIds.push(listing.externalId);
    // Floor = last returned item in page order (newest-first by start time). Not the min listedAt: itemCreationDate
    // can predate the start time (GTC renewals, revisions) and one outlier would drag the floor back.
    if (listing.listedAt && !Number.isNaN(listing.listedAt.getTime())) windowFloor = listing.listedAt;
    const { isNew } = await upsertListing(deps.db, listing, deps.now());
    if (isNew) summary.new++;
    if (!(await needsEvaluation(deps.db, listing))) continue;
    try {
      const outcome = await evaluateListing(deps, listing, settings, channels);
      await markEvaluated(deps.db, listing, deps.now());
      summary.outcomes[outcome.status] = (summary.outcomes[outcome.status] ?? 0) + 1;
    } catch (err) {
      summary.errors++;
      await recordEvalFailure(deps.db, listing);
      deps.log('error', 'evaluate failed', { externalId: listing.externalId, err: String(err) });
    }
  }
  // Only listings strictly newer than the oldest returned one are "should have been seen". No floor, no counting.
  if (windowFloor) summary.missed = await recordWindowMisses(deps.db, 'ebay', seenIds, windowFloor);
  return summary;
}
