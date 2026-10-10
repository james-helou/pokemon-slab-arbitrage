import { availableCash } from '../bankroll/bankroll-repo.js';
import { findCandidates, findCandidatesInSet, getCard, listSets } from '../catalog/catalog-repo.js';
import type { Channel } from '../channels/channels.js';
import type { Db } from '../db/db.js';
import type { Listing, Match, Valuation, ValuationKey } from '../domain/types.js';
import { insertDelivery, insertRecommendation, recommendationExists } from '../ledger/ledger-repo.js';
import { insertMatch, markGone, upsertListing } from '../listings/listings-repo.js';
import type { Log } from '../log.js';
import { matchListing, type CandidateLookup, type SetLister } from '../matcher/matcher.js';
import { basicRedFlags } from '../risk/basic-flags.js';
import { decideDeal, type DealMode } from '../scoring/deal-modes.js';
import { maxBuyPrice } from '../scoring/max-buy-price.js';
import { score } from '../scoring/scorer.js';
import { DEFAULT_SETTINGS, type Settings } from '../settings/settings.js';
import { soldCheckVerdict, type SoldCheck, type SoldCheckSnapshot } from '../soldcheck/sold-check.js';
import type { EbayClient } from '../sources/ebay/ebay-client.js';
import { isOutOfStock, mergeItemDetails } from '../sources/ebay/normalize.js';

const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface EvaluateDeps {
  db: Db;
  ebay: Pick<EbayClient, 'getItem'>;
  /** opts.spend false = free lookups only (cache); the caller has judged the listing unpromising. */
  valuate: (key: ValuationKey, settings: Settings, opts?: { spend?: boolean }) => Promise<Valuation | null>;
  now: () => Date;
  log: Log;
  /** SOLD_CHECK=on only. Absent: behaviour is exactly as before. Present: may demote an alert, never promote one. */
  soldCheck?: SoldCheck;
  /** Free raw (ungraded) USD price for a card, or null when unknown. Absent: no raw-price pre-filter or flag. */
  rawPrice?: (cardId: string) => Promise<number | null>;
  /** CAD -> USD rate, set by the eBay.ca scan so a CAD getItem response is converted like its summary. */
  cadToUsd?: number;
}

export type EvaluateStatus =
  | 'no_match' | 'grader_disabled' | 'unsupported_label' | 'no_valuation' | 'rejected' | 'gone'
  | 'match_changed' | 'recommended' | 'duplicate';

export interface EvaluateOutcome {
  status: EvaluateStatus;
  reasons: string[];
  recommendationId?: number;
}

function dealMode(l: Listing, settings: Settings): DealMode {
  if (l.auction) return 'auction';
  return settings.offerMode && l.buyingOptions?.includes('BEST_OFFER') ? 'bin_offer' : 'bin';
}

function gate(m: Match, settings: Settings): EvaluateOutcome | null {
  if (!settings.enabledGraders.includes(m.grader)) return { status: 'grader_disabled', reasons: [m.grader] };
  if (m.gradeLabel) return { status: 'unsupported_label', reasons: [m.gradeLabel] };
  if (m.confidence < settings.minMatchConfidence) return { status: 'rejected', reasons: ['low_match_confidence'] };
  return null;
}

/**
 * Stage 1 (free): title match, valuation, and a pre-score. Stage 2 (one getItem call): live check,
 * aspect re-match, red flags, final score, then an immutable recommendation and a queued alert.
 */
export async function evaluateListing(
  deps: EvaluateDeps,
  listing: Listing,
  settings: Settings,
  channels: Channel[],
): Promise<EvaluateOutcome> {
  const { db } = deps;
  const lookup: CandidateLookup = (n, t, set) => (set ? findCandidatesInSet(db, set, n) : findCandidates(db, n, t));
  const sets: SetLister = () => listSets(db);

  const first = await matchListing({ title: listing.title, aspects: listing.aspects }, lookup, sets);
  await insertMatch(db, listing, first, 'title');
  if (!first.match) return { status: 'no_match', reasons: first.reasons };
  const gate1 = gate(first.match, settings);
  if (gate1) return gate1;

  const key: ValuationKey = { cardId: first.match.cardId, grader: first.match.grader, grade: first.match.grade };
  // Best Offer: triage and pre-score at the lowest offer we would alert on (auctions: listing.price is the current bid).
  const mode1 = dealMode(listing, settings);
  const triagePrice = mode1 === 'bin_offer' ? round2(settings.offerMinPctOfAsk * listing.price) : listing.price;
  const rawUsd = deps.rawPrice ? await deps.rawPrice(key.cardId) : null;
  // Unknown raw price: cannot judge, so spend as before.
  let promising = true;
  if (rawUsd !== null) {
    const mults = settings.rawCeilingMultipliers;
    const fallback = DEFAULT_SETTINGS.rawCeilingMultipliers;
    const mult = mults[String(key.grade)] ?? mults['default'] ?? fallback['default']!;
    const ceiling = rawUsd * mult;
    if (ceiling < settings.valueFloor) return { status: 'rejected', reasons: ['raw_ceiling_below_floor'] };
    const shipping = listing.shipping ?? settings.stage1ShippingEstimate;
    if (triagePrice + shipping > settings.alertRatio * ceiling) {
      return { status: 'rejected', reasons: ['price_above_raw_ceiling'] };
    }
    // Promise triage: even at the best plausible graded price (p90 of measured ratios) this could not clear the alert
    // ratio, so do not spend a metered vendor credit on it.
    const promiseMults = settings.rawPromiseMultipliers;
    const promiseMult = promiseMults[String(key.grade)] ?? promiseMults['default'] ?? DEFAULT_SETTINGS.rawPromiseMultipliers['default']!;
    const cost = (triagePrice + shipping) * (1 + settings.buyTaxRate + settings.fxFeePct);
    promising = cost <= settings.alertRatio * rawUsd * promiseMult;
  }

  // Auctions an hour out often sit at $1-$20 bids and would all look promising: by default they use cached PPT comps only.
  const auctionNoCredit = mode1 === 'auction' && !settings.auctionSpendsCredits;
  const spend = promising && !auctionNoCredit;
  const noSpendReason = !promising ? 'not_promising' : 'auction_no_credit';
  const valuation = await deps.valuate(key, settings, { spend });
  if (!valuation) return { status: 'no_valuation', reasons: spend ? [] : [noSpendReason] };
  // Triage only ever withholds spending. A listing we did not spend on must not fall through to a different source (own comps).
  if (!spend && valuation.compsSource !== 'ppt') return { status: 'no_valuation', reasons: [noSpendReason] };
  if (deps.now().getTime() - valuation.computedAt.getTime() > settings.valuationMaxAgeHours * 3_600_000) {
    return { status: 'rejected', reasons: ['stale_valuation'] };
  }

  const cash = await availableCash(db);
  // Search summaries often carry no shipping (calculated rates); pre-score with the estimate. Stage 2 uses the real cost.
  const pre = score({
    price: triagePrice, shipping: listing.shipping ?? settings.stage1ShippingEstimate, valuation, matchConfidence: first.match.confidence,
    redFlags: [], channels, settings, availableCash: cash,
  });
  if (pre.decision === 'reject') return { status: 'rejected', reasons: pre.rejectReasons };

  // Auctions: the most generous case (free shipping) still has to leave room under the alert fraction, else skip getItem.
  if (mode1 === 'auction') {
    const optimistic = maxBuyPrice({
      shipping: listing.shipping ?? 0, valuation, matchConfidence: first.match.confidence, redFlags: [], channels, settings,
      availableCash: cash,
    });
    if (optimistic === null || listing.price > settings.auctionAlertPct * optimistic) {
      return { status: 'rejected', reasons: ['auction_bid_too_high'] };
    }
  }

  const item = await deps.ebay.getItem(listing.externalId);
  if (!item || isOutOfStock(item)) {
    await markGone(db, listing, deps.now(), item ? 'out_of_stock' : 'not_found');
    return { status: 'gone', reasons: [] };
  }
  const enriched = mergeItemDetails(listing, item, deps.cadToUsd === undefined ? {} : { cadToUsd: deps.cadToUsd });
  if (!enriched) return { status: 'rejected', reasons: ['invalid_listing'] };
  await upsertListing(db, enriched, deps.now());

  const second = await matchListing({ title: enriched.title, aspects: enriched.aspects }, lookup, sets);
  await insertMatch(db, enriched, second, 'enriched');
  if (!second.match) return { status: 'no_match', reasons: second.reasons };
  const m = second.match;
  if (m.cardId !== key.cardId || m.grader !== key.grader || m.grade !== key.grade) {
    return { status: 'match_changed', reasons: ['enriched_match_differs'] };
  }
  const gate2 = gate(m, settings);
  if (gate2) return gate2;

  if (enriched.shipping === null) return { status: 'rejected', reasons: ['shipping_unknown'] };

  const redFlags = basicRedFlags(enriched, m);
  if (rawUsd !== null && valuation.value < rawUsd) {
    redFlags.push({ code: 'graded_below_raw', blocking: false, confidencePenalty: 0.3 });
  }
  const d = decideDeal({
    mode: dealMode(enriched, settings),
    ask: enriched.price,
    base: {
      shipping: enriched.shipping, valuation, matchConfidence: m.confidence, redFlags, channels, settings,
      availableCash: cash,
    },
    settings,
  });
  const final = d.score;
  if (d.kind === null || final.decision === 'reject' || final.bestChannel === null) {
    return { status: 'rejected', reasons: d.reasons.length > 0 ? d.reasons : final.rejectReasons };
  }

  const card = await getCard(db, key.cardId);
  if (!card) return { status: 'no_match', reasons: ['card_missing'] };
  let routedTo: 'alerts' | 'over_budget' = final.decision === 'alert' ? 'alerts' : 'over_budget';
  const flagCodes = redFlags.map((f) => f.code);
  let soldCheck: SoldCheckSnapshot | undefined;
  // Alert candidates only: an over_budget one cannot be demoted, so checking it would just spend the daily cap.
  if (deps.soldCheck && final.decision === 'alert' && !(await recommendationExists(db, 'ebay', enriched.externalId))) {
    soldCheck = await runSoldCheck(deps.soldCheck, deps.log, key, card, settings, valuation.value);
    if (soldCheck.verdict === 'disagrees') {
      flagCodes.push('sold_check_disagrees');
      routedTo = 'over_budget';
    }
  }
  const id = await insertRecommendation(db, {
    source: 'ebay',
    externalId: enriched.externalId,
    cardId: key.cardId,
    grader: m.grader,
    grade: m.grade,
    cert: m.cert,
    listingSnapshot: {
      title: enriched.title, url: enriched.url, imageUrl: enriched.imageUrl, price: enriched.price,
      shipping: enriched.shipping, sellerUsername: enriched.sellerUsername,
      sellerFeedbackScore: enriched.sellerFeedbackScore, buyingOptions: enriched.buyingOptions ?? null,
      originalPrice: enriched.originalPrice ?? null, originalCurrency: enriched.originalCurrency ?? null,
      ...(d.kind === 'offer' ? { maxOffer: d.maxPrice } : {}),
      ...(enriched.auction
        ? {
            auction: {
              currentBid: enriched.auction.currentBid, bidCount: enriched.auction.bidCount,
              endsAt: enriched.auction.endsAt.toISOString(),
            },
            ceilingTerms: { taxRate: settings.buyTaxRate + settings.fxFeePct, minNet: settings.minNet, minRoi: settings.minRoi },
          }
        : {}),
    },
    cardSnapshot: { name: card.name, setName: card.setName, number: card.number },
    valuationSnapshot: { ...valuation, computedAt: valuation.computedAt.toISOString() },
    channelNets: final.channelNets,
    bestChannel: final.bestChannel,
    buyTotal: final.buyTotal,
    bestNet: final.bestNet,
    roi: final.roi,
    confidence: final.confidence,
    rank: final.rank,
    redFlags: flagCodes,
    routedTo,
    scorerVersion: final.scorerVersion,
    matcherVersion: m.matcherVersion,
    oracleVersion: valuation.oracleVersion,
    kind: d.kind,
    suggestedPrice: d.suggestedPrice,
    ...(soldCheck ? { soldCheck } : {}),
  });
  if (id === null) return { status: 'duplicate', reasons: [] };
  await insertDelivery(db, id, routedTo);
  return { status: 'recommended', reasons: [], recommendationId: id };
}

/** The runner never throws by contract; this guard keeps a broken dep from ever costing an alert. */
async function runSoldCheck(
  check: SoldCheck, log: Log, key: ValuationKey, card: { name: string; number: string; setName: string },
  settings: Settings, value: number,
): Promise<SoldCheckSnapshot> {
  try {
    const r = await check(key, { name: card.name, number: card.number, setName: card.setName }, settings);
    return { ...r, verdict: soldCheckVerdict(r, value, settings) };
  } catch (err) {
    log('error', 'sold check threw', { cardId: key.cardId, message: err instanceof Error ? err.message : String(err) });
    return {
      status: 'error', saleCount: 0, median: null, low: null, high: null, newestSoldAt: null, fetchedAt: null,
      fromCache: false, parserVersion: null, verdict: 'unavailable',
    };
  }
}
