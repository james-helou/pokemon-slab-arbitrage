import type { Channel } from '../channels/channels.js';
import type { Listing } from '../domain/types.js';
import { markEvaluated, needsEvaluation, recordEvalFailure, upsertListing } from '../listings/listings-repo.js';
import type { Settings } from '../settings/settings.js';
import { evaluateListing, type EvaluateDeps } from './evaluate.js';

export interface IngestSummary {
  new: number;
  errors: number;
  outcomes: Record<string, number>;
}

/** Stores a listing and, if it has not been evaluated yet, evaluates it. One failure never stops the scan. */
export async function ingestListing(
  deps: EvaluateDeps,
  listing: Listing,
  settings: Settings,
  channels: Channel[],
  summary: IngestSummary,
): Promise<void> {
  const { isNew } = await upsertListing(deps.db, listing, deps.now());
  if (isNew) summary.new++;
  if (!(await needsEvaluation(deps.db, listing))) return;
  try {
    const outcome = await evaluateListing(deps, listing, settings, channels);
    // An auction with no cached valuation yet is retried by the next auction scan (no getItem is spent on it).
    if (!(listing.origin === 'auction' && outcome.status === 'no_valuation')) await markEvaluated(deps.db, listing, deps.now());
    summary.outcomes[outcome.status] = (summary.outcomes[outcome.status] ?? 0) + 1;
  } catch (err) {
    summary.errors++;
    await recordEvalFailure(deps.db, listing);
    deps.log('error', 'evaluate failed', { externalId: listing.externalId, err: String(err) });
  }
}
