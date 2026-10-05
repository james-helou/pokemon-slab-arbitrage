import { findCandidates, findPromoCandidates } from '../catalog/catalog-repo.js';
import type { Db } from '../db/db.js';
import { buildCheckLinks } from '../discord/check-links.js';
import type { Log } from '../log.js';
import type { CandidateLookup } from '../matcher/matcher.js';
import type { Settings } from '../settings/settings.js';
import { detectBlocked, parseSoldResults, PARSER_VERSION } from './parse.js';
import {
  blockedSince, countSoldChecksSince, insertSoldCheck, lastSoldCheckAt, latestOkSoldCheck,
  type SoldCheckKey, type SoldCheckStatus,
} from './sold-checks-repo.js';
import { summarizeSales } from './summarize.js';

export const BREAKER_HOURS = 24;
const FETCH_TIMEOUT_MS = 10_000;
const HOUR = 3_600_000;

export type SoldCheckRunStatus = SoldCheckStatus | 'skipped_budget' | 'skipped_rate' | 'skipped_blocked';

/** JSON-safe (ISO date strings): this is also the shape snapshotted into recommendations.sold_check. */
export interface SoldCheckResult {
  status: SoldCheckRunStatus;
  saleCount: number;
  median: number | null;
  low: number | null;
  high: number | null;
  newestSoldAt: string | null;
  fetchedAt: string | null;
  fromCache: boolean;
  parserVersion: string | null;
}

/** agrees/disagrees need an ok check with >= soldCheckMinSales sales; insufficient is ok with fewer; else unavailable. */
export type SoldCheckVerdict = 'agrees' | 'disagrees' | 'insufficient' | 'unavailable';
export type SoldCheckSnapshot = SoldCheckResult & { verdict: SoldCheckVerdict };

/**
 * Pure. Disagrees only when our valuation sits more than soldCheckMaxGap above the sold median. A sold median above
 * the valuation is never a reason to act: the check may demote an alert, never promote one.
 */
export function soldCheckVerdict(
  r: SoldCheckResult, value: number, settings: Pick<Settings, 'soldCheckMinSales' | 'soldCheckMaxGap'>,
): SoldCheckVerdict {
  if (r.status !== 'ok' || r.median === null) return 'unavailable';
  if (r.saleCount < settings.soldCheckMinSales) return 'insufficient';
  return value > r.median * (1 + settings.soldCheckMaxGap) ? 'disagrees' : 'agrees';
}

export interface SoldCheckCard {
  name: string;
  number: string;
  setName: string;
}

export type SoldCheckSettings = Pick<
  Settings, 'soldCheckDailyCap' | 'soldCheckMinSpacingSeconds' | 'soldCheckCacheHours' | 'minMatchConfidence'
>;

export type SoldCheck = (key: SoldCheckKey, card: SoldCheckCard, settings: SoldCheckSettings) => Promise<SoldCheckResult>;

export interface SoldCheckDeps {
  db: Db;
  fetch: typeof fetch;
  now: () => Date;
  log: Log;
}

/**
 * The one request shape this feature ever sends (runner and probe). No cookies, no account, no spoofed browser
 * identity, no retry: Node's default fetch plus plain content negotiation and a 10 s timeout.
 */
export async function fetchSoldPage(fetchFn: typeof fetch, url: string): Promise<{ status: number; html: string }> {
  const res = await fetchFn(url, {
    method: 'GET',
    headers: { Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return { status: res.status, html: await res.text() };
}

const empty = (status: SoldCheckRunStatus, fetchedAt: Date | null = null): SoldCheckResult => ({
  status, saleCount: 0, median: null, low: null, high: null, newestSoldAt: null,
  fetchedAt: fetchedAt?.toISOString() ?? null, fromCache: false, parserVersion: fetchedAt ? PARSER_VERSION : null,
});

const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

/**
 * The guarded eBay sold-listings check for one alert candidate. Order: cache, breaker, daily cap, spacing, then
 * exactly one plain logged-out GET. Every fetch writes one sold_checks row. Never throws: any failure is 'error'.
 */
export function createSoldCheck(deps: SoldCheckDeps): SoldCheck {
  const { db, log } = deps;
  const lookup: CandidateLookup = (n, t, promo) => (promo ? findPromoCandidates(db, promo, n) : findCandidates(db, n, t));
  // In-process floor under the DB-derived guards, so a failed sold_checks insert cannot let the next candidate fetch.
  let lastFetchAt: Date | null = null;
  let fetchDay = '';
  let fetchCount = 0;
  const noteFetch = (at: Date) => {
    const day = startOfUtcDay(at).toISOString();
    if (day !== fetchDay) { fetchDay = day; fetchCount = 0; }
    fetchCount += 1;
    lastFetchAt = at;
  };
  const fetchesToday = (at: Date) => (startOfUtcDay(at).toISOString() === fetchDay ? fetchCount : 0);

  async function fetchAndRecord(key: SoldCheckKey, card: SoldCheckCard, settings: SoldCheckSettings, at: Date) {
    const link = buildCheckLinks({ ...card, grader: key.grader, grade: key.grade }).find((l) => l.label === 'eBay sold');
    if (!link) return empty('error');
    const query = new URL(link.url).searchParams.get('_nkw') ?? '';
    const record = async (status: SoldCheckStatus, summary?: Awaited<ReturnType<typeof summarizeSales>>) => {
      await insertSoldCheck(db, {
        ...key, query, status, fetchedAt: at, saleCount: summary?.saleCount ?? 0, median: summary?.median ?? null,
        low: summary?.low ?? null, high: summary?.high ?? null, newestSoldAt: summary?.newestSoldAt ?? null,
        matchedTitles: summary?.matchedTitles ?? [], parserVersion: PARSER_VERSION,
      });
    };

    let status: number;
    let html: string;
    try {
      ({ status, html } = await fetchSoldPage(deps.fetch, link.url));
    } catch (err) {
      noteFetch(at);
      log('warn', 'sold check fetch failed', { cardId: key.cardId, message: err instanceof Error ? err.message : String(err) });
      await record('error');
      return empty('error', at);
    }
    noteFetch(at);

    if (detectBlocked(html, status)) {
      log('warn', 'sold check blocked; breaker open', { cardId: key.cardId, status, hours: BREAKER_HOURS });
      await record('blocked');
      return empty('blocked', at);
    }
    if (status < 200 || status >= 300) {
      log('warn', 'sold check http error', { cardId: key.cardId, status });
      await record('error');
      return empty('error', at);
    }

    const summary = await summarizeSales(parseSoldResults(html), {
      key, lookup, minMatchConfidence: settings.minMatchConfidence, now: at,
    });
    await record(summary.status, summary);
    return {
      status: summary.status, saleCount: summary.saleCount, median: summary.median, low: summary.low, high: summary.high,
      newestSoldAt: summary.newestSoldAt?.toISOString() ?? null, fetchedAt: at.toISOString(), fromCache: false,
      parserVersion: PARSER_VERSION,
    } satisfies SoldCheckResult;
  }

  return async (key, card, settings) => {
    try {
      const at = deps.now();
      const cached = await latestOkSoldCheck(db, key, settings.soldCheckCacheHours, at);
      if (cached) {
        return {
          status: 'ok', saleCount: cached.saleCount, median: cached.median, low: cached.low, high: cached.high,
          newestSoldAt: cached.newestSoldAt?.toISOString() ?? null, fetchedAt: cached.fetchedAt.toISOString(),
          fromCache: true, parserVersion: cached.parserVersion,
        };
      }
      if (await blockedSince(db, new Date(at.getTime() - BREAKER_HOURS * HOUR))) return empty('skipped_blocked');
      const count = Math.max(await countSoldChecksSince(db, startOfUtcDay(at)), fetchesToday(at));
      if (count >= settings.soldCheckDailyCap) return empty('skipped_budget');
      const dbLast = await lastSoldCheckAt(db);
      const last = [dbLast, lastFetchAt].reduce<Date | null>((a, b) => (b && (!a || b > a) ? b : a), null);
      if (last && at.getTime() - last.getTime() < settings.soldCheckMinSpacingSeconds * 1000) return empty('skipped_rate');
      return await fetchAndRecord(key, card, settings, at);
    } catch (err) {
      log('error', 'sold check failed', { cardId: key.cardId, message: err instanceof Error ? err.message : String(err) });
      return empty('error');
    }
  };
}
