import { loadChannels } from '../channels/channels.js';
import { upsertListing } from '../listings/listings-repo.js';
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
  errors: number;
  outcomes: Record<string, number>;
}

export async function scanCycle(deps: ScanDeps, cycle: number): Promise<ScanSummary> {
  const summary: ScanSummary = { status: 'ok', seen: 0, new: 0, errors: 0, outcomes: {} };
  const settings = await loadSettings(deps.db);
  if (settings.paused) return { ...summary, status: 'paused' };
  if ((await deps.budget.usedToday()) >= deps.budget.limit * 0.9 && cycle % 2 === 1) {
    return { ...summary, status: 'throttled' };
  }

  const channels = await loadChannels(deps.db);
  const results = await deps.ebay.searchNewGraded();
  summary.seen = results.length;
  for (const s of results) {
    const listing = summaryToListing(s);
    if (!listing) continue;
    const { isNew } = await upsertListing(deps.db, listing, deps.now());
    if (!isNew) continue;
    summary.new++;
    try {
      const outcome = await evaluateListing(deps, listing, settings, channels);
      summary.outcomes[outcome.status] = (summary.outcomes[outcome.status] ?? 0) + 1;
    } catch (err) {
      summary.errors++;
      deps.log('error', 'evaluate failed', { externalId: listing.externalId, err: String(err) });
    }
  }
  return summary;
}
