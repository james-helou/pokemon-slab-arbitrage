import { availableCash } from '../bankroll/bankroll-repo.js';
import { findCandidates, getCard } from '../catalog/catalog-repo.js';
import type { Channel } from '../channels/channels.js';
import type { Db } from '../db/db.js';
import type { Listing, Match, Valuation, ValuationKey } from '../domain/types.js';
import { insertDelivery, insertRecommendation } from '../ledger/ledger-repo.js';
import { insertMatch, markGone, upsertListing } from '../listings/listings-repo.js';
import type { Log } from '../log.js';
import { matchListing, type CandidateLookup } from '../matcher/matcher.js';
import { basicRedFlags } from '../risk/basic-flags.js';
import { score } from '../scoring/scorer.js';
import type { Settings } from '../settings/settings.js';
import type { EbayClient } from '../sources/ebay/ebay-client.js';
import { isOutOfStock, mergeItemDetails } from '../sources/ebay/normalize.js';

export interface EvaluateDeps {
  db: Db;
  ebay: Pick<EbayClient, 'getItem'>;
  valuate: (key: ValuationKey, settings: Settings) => Promise<Valuation | null>;
  now: () => Date;
  log: Log;
}

export type EvaluateStatus =
  | 'no_match' | 'grader_disabled' | 'unsupported_label' | 'no_valuation' | 'rejected' | 'gone'
  | 'match_changed' | 'recommended' | 'duplicate';

export interface EvaluateOutcome {
  status: EvaluateStatus;
  reasons: string[];
  recommendationId?: number;
}

function gate(m: Match, settings: Settings): EvaluateOutcome | null {
  if (!settings.enabledGraders.includes(m.grader)) return { status: 'grader_disabled', reasons: [m.grader] };
  if (m.gradeLabel) return { status: 'unsupported_label', reasons: [m.gradeLabel] };
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
  const lookup: CandidateLookup = (n, t) => findCandidates(db, n, t);

  const first = await matchListing({ title: listing.title, aspects: listing.aspects }, lookup);
  await insertMatch(db, listing, first, 'title');
  if (!first.match) return { status: 'no_match', reasons: first.reasons };
  const gate1 = gate(first.match, settings);
  if (gate1) return gate1;

  const key: ValuationKey = { cardId: first.match.cardId, grader: first.match.grader, grade: first.match.grade };
  const valuation = await deps.valuate(key, settings);
  if (!valuation) return { status: 'no_valuation', reasons: [] };

  if (listing.shipping === null) return { status: 'rejected', reasons: ['shipping_unknown'] };

  const cash = await availableCash(db);
  const pre = score({
    price: listing.price, shipping: listing.shipping, valuation, matchConfidence: first.match.confidence,
    redFlags: [], channels, settings, availableCash: cash,
  });
  if (pre.decision === 'reject') return { status: 'rejected', reasons: pre.rejectReasons };

  const item = await deps.ebay.getItem(listing.externalId);
  if (!item || isOutOfStock(item)) {
    await markGone(db, listing, deps.now());
    return { status: 'gone', reasons: [] };
  }
  const enriched = mergeItemDetails(listing, item);
  if (!enriched) return { status: 'rejected', reasons: ['invalid_listing'] };
  await upsertListing(db, enriched, deps.now());

  const second = await matchListing({ title: enriched.title, aspects: enriched.aspects }, lookup);
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
  const final = score({
    price: enriched.price, shipping: enriched.shipping, valuation, matchConfidence: m.confidence,
    redFlags, channels, settings, availableCash: cash,
  });
  if (final.decision === 'reject' || final.bestChannel === null) {
    return { status: 'rejected', reasons: final.rejectReasons };
  }

  const card = await getCard(db, key.cardId);
  if (!card) return { status: 'no_match', reasons: ['card_missing'] };
  const routedTo = final.decision === 'alert' ? 'alerts' : 'over_budget';
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
      sellerFeedbackScore: enriched.sellerFeedbackScore,
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
    redFlags: redFlags.map((f) => f.code),
    routedTo,
    scorerVersion: final.scorerVersion,
    matcherVersion: m.matcherVersion,
    oracleVersion: valuation.oracleVersion,
  });
  if (id === null) return { status: 'duplicate', reasons: [] };
  await insertDelivery(db, id, routedTo);
  return { status: 'recommended', reasons: [], recommendationId: id };
}
