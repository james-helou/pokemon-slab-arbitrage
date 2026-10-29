import { getCard } from '../catalog/catalog-repo.js';
import type { Db } from '../db/db.js';
import type { AlertPayload } from '../discord/alert-payload.js';
import { buildWatchPayload } from '../discord/watch-payload.js';
import type { Grader, Listing, ValuationKey } from '../domain/types.js';
import type { Log } from '../log.js';
import { matchListing } from '../matcher/matcher.js';
import { AUCTION_MIN_LEAD_MINUTES } from '../pipeline/auction-scan.js';
import { catalogLookup, gate } from '../pipeline/evaluate.js';
import { round2 } from '../scoring/fees.js';
import { loadSettings, type Settings } from '../settings/settings.js';
import { AUX_MAIN_RESERVE_RATIO, claimAuxCall, WATCH_SOURCE } from '../sources/ebay/aux-budget.js';
import type { Budget } from '../sources/ebay/budget.js';
import type { EbayClient, EbayItemSummary } from '../sources/ebay/ebay-client.js';
import { itemCountry, mergeItemDetails, summaryToListing } from '../sources/ebay/normalize.js';
import { marketValue, type SourceReader } from './market-value.js';
import {
  claimAlert, dueForFinalCheck, endedUnfinalized, finalize, releaseAlert, setMatch, upsertSeen, type WatchRow,
} from './watch-repo.js';
import { belowGap, decideWatch } from './watch-rule.js';

export interface WatchScanDeps {
  db: Db;
  ebay: Pick<EbayClient, 'searchLiveAuctions' | 'getItem'>;
  budget: Budget;
  readers: SourceReader[];
  send: (p: AlertPayload) => Promise<string>;
  now: () => Date;
  log: Log;
  usdCad?: () => Promise<number | null>;
}

export interface WatchScanSummary {
  status: 'ok' | 'paused' | 'disabled' | 'throttled';
  seen: number;
  candidates: number;
  matched: number;
  alerts: number;
  realerts: number;
  /** Auctions left undecided because a value source could not try; retried next pass. */
  deferred: number;
  finalized: number;
  errors: number;
}

type MatchOutcome = { cardId: string; grader: Grader; grade: number } | { status: string };

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * One watchlist pass: search live auctions, match each once, alert when the bid beats market value, refresh bids
 * near the end, and record results. One failing auction is logged and never stops the pass.
 */
export async function watchScan(deps: WatchScanDeps): Promise<WatchScanSummary> {
  const summary: WatchScanSummary = {
    status: 'ok', seen: 0, candidates: 0, matched: 0, alerts: 0, realerts: 0, deferred: 0, finalized: 0, errors: 0,
  };
  const { db, log } = deps;
  const settings = await loadSettings(db);
  if (settings.paused) return { ...summary, status: 'paused' };
  if (!settings.watchMode) return { ...summary, status: 'disabled' };
  // Same line as aux calls: the main scan keeps priority.
  if ((await deps.budget.usedToday()) >= deps.budget.limit * AUX_MAIN_RESERVE_RATIO) return { ...summary, status: 'throttled' };

  const now = deps.now();
  // The CAD rate is fetched at most once per pass, and only when there is something to send.
  let rate: Promise<number | null> | undefined;
  const usdCad = () => (rate ??= deps.usdCad ? deps.usdCad().catch(() => null) : Promise.resolve(null));

  // Watch getItems have their own daily counter (WATCH_SOURCE), still counted by the main budget in the client.
  const claimGetItem = () => claimAuxCall(db, deps.budget, settings.watchGetItemDailyCap, deps.now, WATCH_SOURCE);
  // Matching getItems are also capped per pass, so a backlog of new auctions cannot spend the day at once.
  let matchGetItems = 0;
  const claimMatchGetItem = async () => {
    if (matchGetItems >= settings.watchGetItemsPerPass) return false;
    if (!(await claimGetItem())) return false;
    matchGetItems++;
    return true;
  };

  let results: EbayItemSummary[] = [];
  // A partial search (a later page failed) still counts as a search that ran.
  let searched = false;
  try {
    const r = await deps.ebay.searchLiveAuctions({
      windowHours: settings.watchWindowHours, minBid: settings.watchMinBid, maxPages: settings.watchMaxPages,
    });
    results = r.items;
    searched = true;
    if (!r.complete) log('warn', 'watch search partial', { items: r.items.length });
  } catch (err) {
    summary.errors++;
    log('error', 'watch search failed', { err: errText(err) });
  }
  summary.seen = results.length;
  const cutoff = now.getTime() + AUCTION_MIN_LEAD_MINUTES * 60_000;
  for (const s of results) {
    try {
      const listing = summaryToListing(s, { origin: 'auction' });
      if (!listing?.auction || listing.auction.bidCount < settings.watchMinBids) continue;
      // Stored even when close to the end: the refreshed bid is what the result records.
      const row = await upsertSeen(db, {
        source: 'ebay', externalId: listing.externalId, title: listing.title, url: listing.url, imageUrl: listing.imageUrl,
        endsAt: listing.auction.endsAt, currentBid: listing.auction.currentBid, bidCount: listing.auction.bidCount,
      }, now);
      if (listing.auction.endsAt.getTime() < cutoff) continue;
      summary.candidates++;
      await watchOne(deps, settings, row, listing, summary, usdCad, claimMatchGetItem);
    } catch (err) {
      summary.errors++;
      log('error', 'watch auction failed', { externalId: s.itemId, err: errText(err) });
    }
  }

  await finalCheck(deps, settings, now, summary, claimGetItem);
  // Without a search this pass the stored bids may be stale: finalize next pass instead.
  if (!searched) return summary;
  for (const r of await endedUnfinalized(db, now)) {
    try {
      await finalize(db, r, {
        finalBid: r.currentBid, finalBidCount: r.bidCount, endedAt: r.endsAt, finalWindowMinutes: settings.watchFinalCheckMinutes,
      });
      summary.finalized++;
    } catch (err) {
      summary.errors++;
      log('error', 'watch finalize failed', { externalId: r.externalId, err: errText(err) });
    }
  }
  return summary;
}

async function watchOne(
  deps: WatchScanDeps, settings: Settings, seen: WatchRow, listing: Listing, summary: WatchScanSummary,
  usdCad: () => Promise<number | null>, claimGetItem: () => Promise<boolean>,
): Promise<void> {
  const { db } = deps;
  let row = seen;
  if (row.matchStatus === null) {
    const m = await matchAuction(deps, settings, listing, claimGetItem);
    if (m === null) return; // no watch getItem left (today or this pass): retried next pass
    await setMatch(db, row, m);
    if ('status' in m) return;
    summary.matched++;
    row = { ...row, ...m, matchStatus: 'ok' };
  }
  if (row.matchStatus !== 'ok' || row.cardId === null || row.grader === null || row.grade === null) return;
  const realerted = row.realertedAt !== null;
  // Nothing left to say, or the bid has not climbed enough to re-alert: skip pricing (PPT credits).
  if (realerted) return;
  if (row.alertedBid !== null && row.currentBid < round2(row.alertedBid * (1 + settings.watchRealertPct))) return;

  const key: ValuationKey = { cardId: row.cardId, grader: row.grader, grade: row.grade };
  const mv = await marketValue(key, deps.readers, deps.log, { settled: (max) => belowGap(row.currentBid, max, settings) });
  if (mv === 'deferred') {
    // A guide could not be read (credits, outage): no decision on the rest, the next pass retries.
    summary.deferred++;
    return;
  }
  const v = decideWatch(
    { bid: row.currentBid, bidCount: row.bidCount, value: mv?.value ?? null, alertedBid: row.alertedBid, realerted },
    settings,
  );
  if (v.action === 'none' || mv === null) return;
  const card = await getCard(db, key.cardId);
  if (!card) return;
  const payload = buildWatchPayload({
    title: row.title, url: row.url, imageUrl: row.imageUrl, cardName: card.name, setName: card.setName,
    number: card.number, grader: key.grader, grade: key.grade, bid: row.currentBid, bidCount: row.bidCount,
    endsAt: row.endsAt, value: mv.value, sources: mv.sources, gapUsd: v.gapUsd, gapPct: v.gapPct,
    realert: v.action === 'realert',
  }, { now: deps.now(), usdCad: await usdCad() });
  // Claim first: only the pass that wins the claim sends (overlapping deploys), and a failed bookkeeping write can no
  // longer follow a successful send.
  const realert = v.action === 'realert';
  const claimedAt = deps.now();
  if (!(await claimAlert(db, row, { bid: row.currentBid, value: mv.value, sources: mv.sources, now: claimedAt, realert }))) return;
  try {
    await deps.send(payload);
  } catch (err) {
    // Released: the next pass retries the alert. A failed release is logged; the claim then stands (no duplicate).
    summary.errors++;
    deps.log('error', 'watch alert send failed', { externalId: row.externalId, err: errText(err) });
    await releaseAlert(db, row, { now: claimedAt, realert }).catch((e: unknown) => {
      deps.log('error', 'watch alert release failed', { externalId: row.externalId, err: errText(e) });
    });
    return;
  }
  if (v.action === 'realert') summary.realerts++;
  else summary.alerts++;
}

/** Title match, then one getItem to re-match on aspects (as stage 2 of evaluate.ts). null = no getItem left. */
async function matchAuction(
  deps: WatchScanDeps, settings: Settings, listing: Listing, claimGetItem: () => Promise<boolean>,
): Promise<MatchOutcome | null> {
  const { lookup, sets } = catalogLookup(deps.db);
  const first = await matchListing({ title: listing.title, aspects: listing.aspects, itemCountry: itemCountry(listing) }, lookup, sets);
  if (!first.match) return { status: `no_match:${first.reasons.join(',')}` };
  const g1 = gateStatus(first.match, settings);
  if (g1) return { status: g1 };
  if (!(await claimGetItem())) return null;
  const item = await deps.ebay.getItem(listing.externalId);
  if (!item) return { status: 'gone' };
  const enriched = mergeItemDetails(listing, item, { origin: 'auction' });
  if (!enriched) return { status: 'invalid_listing' };
  const second = await matchListing({ title: enriched.title, aspects: enriched.aspects, itemCountry: itemCountry(enriched) }, lookup, sets);
  if (!second.match) return { status: `no_match:${second.reasons.join(',')}` };
  const m = second.match;
  if (m.cardId !== first.match.cardId || m.grader !== first.match.grader || m.grade !== first.match.grade) {
    return { status: 'match_changed' };
  }
  const g2 = gateStatus(m, settings);
  if (g2) return { status: g2 };
  return { cardId: m.cardId, grader: m.grader, grade: m.grade };
}

function gateStatus(m: Parameters<typeof gate>[0], settings: Settings): string | null {
  const g = gate(m, settings);
  if (!g) return null;
  if (g.status === 'grader_disabled') return 'grader_disabled';
  if (g.status === 'unsupported_label') return 'label';
  return 'low_confidence';
}

/**
 * Matched auctions ending before the next pass: refresh the bid (and reservePriceMet, which the search lacks) by
 * getItem, even when this pass's search returned them, and record last_seen_at.
 *
 * Trade-off: passes run every watchScanMinutes (15) but the final window is watchFinalCheckMinutes (10), so an auction
 * is not always inside its final window at any pass. We refresh everything ending before the next pass (the latest
 * sighting we will ever get), and finalize writes a comp only when that sighting landed in the final window. Auctions
 * whose last pass fell earlier are recorded without a comp: fewer results, but no stale bid passed off as a sale.
 */
async function finalCheck(
  deps: WatchScanDeps, settings: Settings, now: Date, summary: WatchScanSummary,
  claimGetItem: () => Promise<boolean>,
): Promise<void> {
  for (const r of await dueForFinalCheck(deps.db, now, settings.watchScanMinutes)) {
    try {
      if (!(await claimGetItem())) return;
      const item = await deps.ebay.getItem(r.externalId);
      const l = item ? summaryToListing(item, { origin: 'auction' }) : null;
      if (!l?.auction) continue;
      await upsertSeen(deps.db, {
        source: r.source, externalId: r.externalId, title: l.title, url: r.url, imageUrl: l.imageUrl ?? r.imageUrl,
        endsAt: l.auction.endsAt, currentBid: l.auction.currentBid, bidCount: l.auction.bidCount,
        reserveMet: typeof item?.reservePriceMet === 'boolean' ? item.reservePriceMet : null,
      }, now);
    } catch (err) {
      summary.errors++;
      deps.log('error', 'watch final check failed', { externalId: r.externalId, err: errText(err) });
    }
  }
}
