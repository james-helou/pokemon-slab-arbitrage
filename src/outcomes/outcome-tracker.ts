import { loadChannels } from '../channels/channels.js';
import type { Db } from '../db/db.js';
import type { Valuation, ValuationKey } from '../domain/types.js';
import { markGone, markSeenLive } from '../listings/listings-repo.js';
import type { Log } from '../log.js';
import { loadSettings, type Settings } from '../settings/settings.js';
import { claimAuxCall } from '../sources/ebay/aux-budget.js';
import type { Budget } from '../sources/ebay/budget.js';
import type { EbayClient } from '../sources/ebay/ebay-client.js';
import { isOutOfStock } from '../sources/ebay/normalize.js';
import { counterfactualNet, labelForNet } from './label.js';
import { decisionSnapshot, dueOutcomes, insertOutcome, type ListingFinalState } from './outcomes-repo.js';

export const OUTCOME_TRACKER_VERSION = 'v1.0.0';
const MAX_DUE_PER_RUN = 100;

export interface OutcomeDeps {
  db: Db;
  ebay: Pick<EbayClient, 'getItem'>;
  /** Main eBay budget; aux calls stop at 80% of it. */
  budget: Budget;
  valuate: (key: ValuationKey, settings: Settings) => Promise<Valuation | null>;
  now: () => Date;
  log: Log;
}

export interface OutcomeRunSummary {
  status: 'ok' | 'paused';
  due: number;
  written: number;
  deferred: number;
  errors: number;
}

interface Observation {
  state: ListingFinalState;
  price: number | null;
}

interface ListingRow {
  /** Final state already confirmed in our DB (no eBay call needed), else null. */
  known: Observation | null;
  lastPrice: number | null;
}

/** What our DB already knows about the listing. A confirmed gone listing is trusted. */
async function listingRow(deps: OutcomeDeps, externalId: string): Promise<ListingRow> {
  const { rows } = await deps.db.query<{ price: string; gone_at: Date | string | null; gone_reason: string | null }>(
    `select price, gone_at, gone_reason from listings where source = 'ebay' and external_id = $1`,
    [externalId],
  );
  const row = rows[0];
  const lastPrice = row ? Number(row.price) : null;
  if (row?.gone_at && row.gone_reason !== 'window_miss') {
    const state: ListingFinalState =
      row.gone_reason === 'out_of_stock' ? 'sold_out' : row.gone_reason === 'not_found' ? 'not_found' : 'gone_unknown';
    return { known: { state, price: lastPrice }, lastPrice };
  }
  return { known: null, lastPrice };
}

/** Listing state now via one budgeted getItem. Null = no aux budget. */
async function observeLive(
  deps: OutcomeDeps, settings: Settings, externalId: string, lastPrice: number | null,
): Promise<Observation | null> {
  if (!(await claimAuxCall(deps.db, deps.budget, settings.auxGetItemDailyCap, deps.now))) return null;
  const ref = { source: 'ebay' as const, externalId };
  const item = await deps.ebay.getItem(externalId);
  if (!item) {
    await markGone(deps.db, ref, deps.now(), 'not_found');
    return { state: 'not_found', price: lastPrice };
  }
  const itemPrice = Number(item.price?.value);
  const price = Number.isFinite(itemPrice) ? itemPrice : lastPrice;
  if (isOutOfStock(item)) {
    await markGone(deps.db, ref, deps.now(), 'out_of_stock');
    return { state: 'sold_out', price };
  }
  await markSeenLive(deps.db, ref, deps.now());
  return { state: 'live', price };
}

/**
 * For every recommendation with elapsed horizons (7/14/30 d) lacking an outcome: observe the listing once,
 * value the card/grade now, label the counterfactual net against settings.minNet, write one row per horizon.
 * Idempotent (unique recommendation+horizon). Per-recommendation errors are isolated and retried next run.
 * Once the aux budget runs out, the rest of the run only handles listings already confirmed gone (no getItem needed).
 */
export async function runOutcomes(deps: OutcomeDeps): Promise<OutcomeRunSummary> {
  const sum: OutcomeRunSummary = { status: 'ok', due: 0, written: 0, deferred: 0, errors: 0 };
  const settings = await loadSettings(deps.db);
  if (settings.paused) return { ...sum, status: 'paused' };
  const channels = await loadChannels(deps.db);
  const due = await dueOutcomes(deps.db, deps.now(), MAX_DUE_PER_RUN);
  sum.due = due.length;
  let auxExhausted = false;
  for (const rec of due) {
    try {
      // Re-check the kill switch per recommendation so /pause takes effect mid-run.
      if ((await loadSettings(deps.db)).paused) {
        sum.status = 'paused';
        break;
      }
      const listing = await listingRow(deps, rec.externalId);
      if (!listing.known && auxExhausted) {
        sum.deferred++;
        continue;
      }
      // Value first: a failing valuation must not spend an aux getItem every run.
      const valuation = await deps.valuate({ cardId: rec.cardId, grader: rec.grader, grade: rec.grade }, settings);
      const obs = listing.known ?? (await observeLive(deps, settings, rec.externalId, listing.lastPrice));
      if (!obs) {
        auxExhausted = true;
        sum.deferred++;
        continue;
      }
      const cf = valuation ? counterfactualNet(channels, valuation.value, rec.buyTotal) : null;
      const decision = await decisionSnapshot(deps.db, rec.id);
      for (const horizon of rec.horizons) {
        const inserted = await insertOutcome(deps.db, {
          recommendationId: rec.id,
          horizonDays: horizon,
          listingFinalState: obs.state,
          observedPrice: obs.price,
          marketValue: valuation?.value ?? null,
          valuationConfidence: valuation?.confidence ?? null,
          valuationCompCount: valuation?.compCount ?? null,
          netAtHorizon: cf?.net ?? null,
          netChannel: cf?.channel ?? null,
          label: cf ? labelForNet(cf.net, settings.minNet) : null,
          labelBasis: cf ? 'counterfactual' : 'no_valuation',
          decision,
          minNet: settings.minNet,
          trackerVersion: OUTCOME_TRACKER_VERSION,
          oracleVersion: valuation?.oracleVersion ?? null,
          observedAt: deps.now(),
        });
        if (inserted) sum.written++;
      }
    } catch (err) {
      sum.errors++;
      deps.log('error', 'outcome failed', {
        recommendationId: rec.id, err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return sum;
}
