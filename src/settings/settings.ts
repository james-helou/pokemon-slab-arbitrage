import type { Db } from '../db/db.js';
import type { Grader } from '../domain/types.js';

export interface Settings {
  paused: boolean;
  enabledGraders: Grader[];
  minNet: number;
  minRoi: number;
  alertRatio: number;
  valueFloor: number;
  buyTaxRate: number;
  /** Card/bank currency-conversion fee on the USD charge (0 = none). Added to the tax rate in the buy total. */
  fxFeePct: number;
  /** Shipping (USD) assumed for the stage-1 pre-score when the search summary has none. Stage 2 uses the real cost. */
  stage1ShippingEstimate: number;
  /** Max plausible graded price as a multiple of the raw (TCGdex) price, by grade ("10", "9.5", ...; "default" otherwise). */
  rawCeilingMultipliers: Record<string, number>;
  /**
   * Promise triage: the best plausible graded price as a multiple of raw (about the measured p90 of PSA/raw ratios,
   * 9.5 and default are guesses). A listing whose buy cost is above alertRatio * raw * this cannot be a deal, so it
   * does not spend PPT credits.
   */
  rawPromiseMultipliers: Record<string, number>;
  /** Multiplier applied to comps whose real price may be hidden (accepted Best Offers). Not applied to paid_source. */
  boDiscount: number;
  valuationMaxAgeHours: number;
  /** Minimum comps in the window required to produce a valuation. */
  minCompCount: number;
  /** Minimum matcher confidence required to proceed (title-only PSA match is 0.855). */
  minMatchConfidence: number;
  scanIntervalSeconds: number;
  deliveryIntervalSeconds: number;
  /** Queued alerts older than this are expired instead of sent. */
  maxAlertAgeMinutes: number;
  browserAgentEnabled: boolean;
  /** Consecutive newest-first scans a listing must be missing from (inside the window) to become a disappearance suspect. */
  disappearMissScans: number;
  /** Suspects priced below this are marked gone without a getItem confirmation (no comp written). */
  disappearMinPrice: number;
  /** Suspects last seen longer ago than this are marked gone unconfirmed (sold time too uncertain for a comp). */
  disappearConfirmMaxAgeHours: number;
  /** Daily cap on auxiliary getItem calls (disappearance confirmations + outcome checks), on top of scanning. */
  auxGetItemDailyCap: number;
  sweepIntervalMinutes: number;
  outcomeIntervalMinutes: number;
  /** Sold check (SOLD_CHECK=on only): max eBay sold-search fetches per UTC day, any status. */
  soldCheckDailyCap: number;
  /** Minimum gap between two sold-search fetches; a closer request is skipped, never slept on. */
  soldCheckMinSpacingSeconds: number;
  /** An ok sold check for the same card+grader+grade is reused for this long. */
  soldCheckCacheHours: number;
  /** Kept sold sales needed before the check may disagree with the valuation. */
  soldCheckMinSales: number;
  /** Disagree (route to over_budget) when valuation > sold median x (1 + this). */
  soldCheckMaxGap: number;
  /** PokemonPriceTracker free-tier credits spendable per UTC day (a card lookup costs 2). The tier allows 100. */
  pptDailyCredits: number;
  /** Credits spendable right at UTC midnight; the rest of pptDailyCredits is released evenly over the day. */
  pptBurstCredits: number;
  /** Best Offer suggestions on. */
  offerMode: boolean;
  /** Alert an offer only if the max offer is at least this fraction of the ask. */
  offerMinPctOfAsk: number;
  /** Auction scan on. */
  auctionMode: boolean;
  auctionScanMinutes: number;
  /** Auctions ending within this many minutes are scanned. */
  auctionWindowMinutes: number;
  /** Alert an auction if the current bid is at most this fraction of the max bid. */
  auctionAlertPct: number;
  /** Auctions may spend metered PPT credits. Off: they alert on cached PPT valuations only (credits are for BIN listings). */
  auctionSpendsCredits: boolean;
  /** eBay.ca scan (Canadian sellers) on. */
  caScan: boolean;
  /** The CA scan runs on main cycles where cycle % n === 0. */
  caScanEveryNCycles: number;
  /** Steal alerts (US BIN + CA scans, old auction scan, outcome tracking) on. Off since the watchlist pivot. */
  stealMode: boolean;
  /** Auction watchlist scan on. */
  watchMode: boolean;
  watchScanMinutes: number;
  /** Live auctions ending within this many hours are watched. */
  watchWindowHours: number;
  /** Search pages (200 items each) per watch scan. */
  watchMaxPages: number;
  /** Minimum current bid (USD) for an auction to be watched. */
  watchMinBid: number;
  /** Minimum bid count before an auction counts (eBay has no distinct-bidder count; 2 = someone was outbid). */
  watchMinBids: number;
  /** Alert when the bid is at least this fraction above market value... */
  watchMinGapPct: number;
  /** ...and at least this many USD above it. */
  watchMinGapUsd: number;
  /** Re-alert once when the bid climbs this fraction above the alerted bid. */
  watchRealertPct: number;
  /** Refresh the bid by getItem in the last this-many minutes of a watched auction. */
  watchFinalCheckMinutes: number;
  /** Daily cap on the watchlist's own getItem calls (matching + final checks), separate from auxGetItemDailyCap. */
  watchGetItemDailyCap: number;
  /** Matching getItems per watch pass; the rest stay unmatched for the next pass. */
  watchGetItemsPerPass: number;
}

export const DEFAULT_SETTINGS: Settings = {
  paused: false,
  enabledGraders: ['PSA'],
  minNet: 75,
  minRoi: 0.2,
  alertRatio: 0.8,
  valueFloor: 150,
  // Buyer is in Laval, Quebec: GST 5% + QST 9.975%.
  buyTaxRate: 0.14975,
  fxFeePct: 0,
  stage1ShippingEstimate: 35,
  rawCeilingMultipliers: { '10': 25, '9.5': 10, '9': 8, default: 4 },
  rawPromiseMultipliers: { '10': 8, '9.5': 4, '9': 2, default: 2 },
  boDiscount: 0.92,
  valuationMaxAgeHours: 24,
  minCompCount: 3,
  minMatchConfidence: 0.85,
  scanIntervalSeconds: 90,
  deliveryIntervalSeconds: 15,
  maxAlertAgeMinutes: 15,
  browserAgentEnabled: false,
  disappearMissScans: 3,
  disappearMinPrice: 75,
  disappearConfirmMaxAgeHours: 24,
  auxGetItemDailyCap: 300,
  sweepIntervalMinutes: 10,
  outcomeIntervalMinutes: 60,
  soldCheckDailyCap: 40,
  soldCheckMinSpacingSeconds: 30,
  soldCheckCacheHours: 12,
  soldCheckMinSales: 5,
  soldCheckMaxGap: 0.2,
  pptDailyCredits: 90,
  pptBurstCredits: 20,
  offerMode: true,
  offerMinPctOfAsk: 0.75,
  auctionMode: true,
  auctionScanMinutes: 10,
  auctionWindowMinutes: 60,
  auctionAlertPct: 0.7,
  auctionSpendsCredits: false,
  caScan: true,
  caScanEveryNCycles: 3,
  stealMode: false,
  watchMode: true,
  watchScanMinutes: 15,
  watchWindowHours: 72,
  watchMaxPages: 3,
  watchMinBid: 300,
  watchMinBids: 2,
  watchMinGapPct: 0.25,
  watchMinGapUsd: 200,
  watchRealertPct: 0.25,
  watchFinalCheckMinutes: 10,
  watchGetItemDailyCap: 200,
  watchGetItemsPerPass: 30,
};

/** Lower bounds for DB-loaded values that would otherwise hammer eBay or Discord. */
const MINIMUMS: Partial<Record<keyof Settings, number>> = {
  scanIntervalSeconds: 30,
  deliveryIntervalSeconds: 5,
  maxAlertAgeMinutes: 1,
  disappearMissScans: 2,
  auxGetItemDailyCap: 0,
  sweepIntervalMinutes: 1,
  outcomeIntervalMinutes: 5,
  soldCheckDailyCap: 0,
  soldCheckMinSpacingSeconds: 10,
  soldCheckCacheHours: 1,
  soldCheckMinSales: 3,
  soldCheckMaxGap: 0.05,
  fxFeePct: 0,
  stage1ShippingEstimate: 0,
  pptDailyCredits: 0,
  pptBurstCredits: 0,
  offerMinPctOfAsk: 0.5,
  auctionScanMinutes: 5,
  auctionWindowMinutes: 15,
  auctionAlertPct: 0.3,
  caScanEveryNCycles: 1,
  watchScanMinutes: 5,
  watchWindowHours: 1,
  watchMaxPages: 1,
  watchMinBid: 50,
  watchMinBids: 1,
  watchMinGapPct: 0.05,
  watchMinGapUsd: 0,
  watchRealertPct: 0.05,
  watchFinalCheckMinutes: 3,
  watchGetItemDailyCap: 0,
  watchGetItemsPerPass: 1,
};

/** Upper bounds for DB-loaded values that would otherwise make the sold check scrape harder or trust too little. */
const MAXIMUMS: Partial<Record<keyof Settings, number>> = {
  soldCheckDailyCap: 200,
  soldCheckMinSpacingSeconds: 600,
  soldCheckCacheHours: 72,
  soldCheckMinSales: 30,
  soldCheckMaxGap: 1,
  fxFeePct: 0.1,
  stage1ShippingEstimate: 200,
  pptDailyCredits: 100,
  pptBurstCredits: 100,
  offerMinPctOfAsk: 1,
  auctionScanMinutes: 60,
  auctionWindowMinutes: 180,
  auctionAlertPct: 1,
  caScanEveryNCycles: 20,
  watchScanMinutes: 120,
  watchWindowHours: 240,
  watchMaxPages: 10,
  watchFinalCheckMinutes: 60,
  watchGetItemDailyCap: 1000,
  watchGetItemsPerPass: 200,
};

/** Non-object -> defaults; a non-positive/non-numeric entry -> that key's default. */
function loadMultipliers(value: unknown, dflt: Record<string, number>): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...dflt };
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : (dflt[k] ?? dflt['default']!);
  }
  return out;
}

export async function loadSettings(db: Db): Promise<Settings> {
  const { rows } = await db.query<{ key: string; value: unknown }>('select key, value from settings');
  const out: Settings = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    if (!(r.key in DEFAULT_SETTINGS)) continue;
    const key = r.key as keyof Settings;
    const dflt = DEFAULT_SETTINGS[key];
    let value = r.value;
    if (typeof dflt === 'number') {
      value = typeof value === 'number' && Number.isFinite(value)
        ? Math.min(Math.max(value, MINIMUMS[key] ?? -Infinity), MAXIMUMS[key] ?? Infinity)
        : dflt;
    }
    // A malformed pause flag fails closed (paused); other flags fall back to their default.
    if (typeof dflt === 'boolean' && typeof value !== 'boolean') value = key === 'paused' ? true : dflt;
    if (key === 'rawCeilingMultipliers' || key === 'rawPromiseMultipliers') value = loadMultipliers(value, DEFAULT_SETTINGS[key]);
    (out as unknown as Record<string, unknown>)[key] = value;
  }
  return out;
}

export async function setSetting<K extends keyof Settings>(db: Db, key: K, value: Settings[K]): Promise<void> {
  await db.query(
    `insert into settings (key, value) values ($1, $2::jsonb)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}
