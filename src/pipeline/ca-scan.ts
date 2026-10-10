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

export interface CaScanDeps extends EvaluateDeps {
  /** The EBAY_CA client (CAD prices, CA-located items). Used for both the search and stage-2 getItem. */
  ebay: EbayClient;
  budget: Budget;
  usdCad: () => Promise<number | null>;
}

export type CaScanSummary = Omit<ScanSummary, 'status'> & { status: ScanSummary['status'] | 'no_fx'; dupes: number };

/** eBay.ca scan for Canadian sellers. Fails closed without an FX rate; skips items another scan owns. */
export function createCaScan(deps: CaScanDeps): () => Promise<CaScanSummary> {
  let noRateLogged = false;
  return async () => {
    const summary: CaScanSummary = { status: 'ok', seen: 0, new: 0, missed: 0, errors: 0, outcomes: {}, dupes: 0 };
    const settings = await loadSettings(deps.db);
    if (settings.paused) return { ...summary, status: 'paused' };
    if (!settings.caScan) return { ...summary, status: 'disabled' };
    // Same line as aux calls: the main scan keeps priority.
    if ((await deps.budget.usedToday()) >= deps.budget.limit * AUX_MAIN_RESERVE_RATIO) return { ...summary, status: 'throttled' };

    const rate = await deps.usdCad().catch(() => null);
    if (rate === null || !Number.isFinite(rate) || rate <= 0) {
      if (!noRateLogged) deps.log('warn', 'ca scan skipped: no usd/cad rate');
      noRateLogged = true;
      return { ...summary, status: 'no_fx' };
    }
    noRateLogged = false;

    const channels = await loadChannels(deps.db);
    const cadToUsd = 1 / rate;
    const evalDeps: EvaluateDeps = { ...deps, cadToUsd };
    const results = await deps.ebay.searchNewGraded();
    summary.seen = results.length;
    for (const s of results) {
      // FIXED_PRICE+AUCTION items belong to the auction scan.
      if (settings.auctionMode && s.buyingOptions?.includes('AUCTION')) continue;
      const listing = summaryToListing(s, { origin: 'ca_bin', cadToUsd });
      if (!listing) continue;
      const owner = await listingOrigin(deps.db, listing);
      if (owner !== null && owner !== 'ca_bin') {
        summary.dupes++;
        continue;
      }
      await ingestListing(evalDeps, listing, settings, channels, summary);
    }
    return summary;
  };
}
