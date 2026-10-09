import type { Db } from '../db/db.js';
import type { ValuationKey } from '../domain/types.js';
import type { Log } from '../log.js';
import type { AggregatePrice, AggregatePriceSource } from '../oracle/aggregate-source.js';
import { tcgplayerIds } from '../poketrace/mapping.js';
import { PptHttpError, PptUnavailableError, type PptClient } from './client.js';

type Key = Parameters<AggregatePriceSource['fetchAggregate']>[0];

const PROVIDER = 'ppt';
/** One card call = 1 credit for the card + 1 for the eBay data. */
const CALL_COST = 2;
const POSITIVE_TTL_MS = 24 * 3_600_000;
const NEGATIVE_TTL_MS = 7 * 86_400_000;
const FAILED_TTL_MS = 3_600_000;
const WINDOW_DAYS = 30;
/** Bump when the parser is verified or changed; the probe prints it. */
export const PPT_PARSER_VERSION: string = 'v1.0.0';

/** PPT's grade key: lowercase grader + grade with _ for decimals (psa10, psa8_5, bgs9_5). */
function gradeKey(key: Pick<Key, 'grader' | 'grade'>): string {
  return `${key.grader}${String(key.grade).replace('.', '_')}`.toLowerCase();
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const MAX_STAMP_AGE_MS = 72 * 3_600_000;
const ID_FIELDS = ['tcgPlayerId', 'tcgplayerId', 'tcgPlayerID', 'tcgplayer_id'];

/** The single card in a response: a bare object or a one-element array whose tcgplayer id equals the requested one. */
function identifiedCard(body: unknown, tcgplayerId: string): Record<string, unknown> | null {
  const data = isObj(body) ? body['data'] : undefined;
  let card: unknown = data;
  if (Array.isArray(data)) card = data.length === 1 ? data[0] : null;
  if (!isObj(card)) return null;
  const id = ID_FIELDS.map((f) => card[f]).find((v) => v !== undefined && v !== null && v !== '');
  return id !== undefined && String(id) === tcgplayerId ? card : null;
}

export interface ParseCtx {
  now: Date;
  /** The tcgplayer id that was requested; the response must be for exactly this card. */
  tcgplayerId: string;
  /** When the body was fetched (cache hits); the fallback asOf when the response carries no timestamp. Default now. */
  fetchedAt?: Date;
}

/**
 * Pulls a graded price out of a PPT card response (shape verified against a real response, 2026-10-09; see
 * tests/fixtures/ppt). null (fail closed) for labelled grades, a response that is not exactly the requested card, a
 * non-USD currency, a missing grade, or anything that is not a recent, trustworthy price.
 *
 * count, medianPrice, averagePrice, minPrice, maxPrice and totalValue are LIFETIME figures and are never used. The
 * value is smartMarketPrice.price (needs confidence high/medium, daysUsed <= 30, a method not starting with "all",
 * and no smartPriceOutlierByGrade flag), lowered to marketPriceMedian7Day when that is lower. lastSaleDate must be
 * within 30 days. The count is dailyVolume7Day * 7.
 */
export function parsePptCard(body: unknown, key: Pick<Key, 'grader' | 'grade' | 'gradeLabel'>, ctx: ParseCtx): AggregatePrice | null {
  if (key.gradeLabel) return null;
  const card = identifiedCard(body, ctx.tcgplayerId);
  if (!card) return null;
  const ebay = card['ebay'];
  if (!isObj(ebay)) return null;
  for (const c of [card['currency'], ebay['currency']]) {
    if (c !== undefined && c !== null && (typeof c !== 'string' || c.toUpperCase() !== 'USD')) return null;
  }
  const k = gradeKey(key);
  const byGrade = ebay['salesByGrade'];
  const g = isObj(byGrade) ? byGrade[k] : undefined;
  if (!isObj(g)) return null;
  const outliers = ebay['smartPriceOutlierByGrade'];
  if (isObj(outliers) && outliers[k] === true) return null;

  const sm = g['smartMarketPrice'];
  if (!isObj(sm)) return null;
  const confidence = sm['confidence'];
  const daysUsed = sm['daysUsed'];
  const method = sm['method'];
  if (confidence !== 'high' && confidence !== 'medium') return null;
  if (!positive(sm['price'])) return null;
  if (typeof daysUsed !== 'number' || !Number.isFinite(daysUsed) || daysUsed <= 0 || daysUsed > WINDOW_DAYS) return null;
  if (typeof method !== 'string' || method.startsWith('all')) return null;
  const median7 = g['marketPriceMedian7Day'];
  const value = positive(median7) ? Math.min(sm['price'], median7) : sm['price'];

  const lastSale = typeof g['lastSaleDate'] === 'string' ? new Date(g['lastSaleDate']) : null;
  if (!lastSale || Number.isNaN(lastSale.getTime()) || ctx.now.getTime() - lastSale.getTime() > WINDOW_DAYS * 86_400_000) return null;

  const vol = g['dailyVolume7Day'];
  if (typeof vol !== 'number' || !Number.isFinite(vol) || vol < 0) return null;
  let saleCount = Math.round(vol * 7);
  // Judgment call: PPT's high-confidence smart price over <= 30 days stands in for a minimum count, so a thin 7 day
  // volume on a card PPT still prices confidently is not discarded by the oracle's minCompCount gate.
  if (confidence === 'high' && saleCount < 3) saleCount = 3;

  const stamp = [g['lastMarketUpdate'], ebay['updatedAt']]
    .find((v): v is string => typeof v === 'string' && !Number.isNaN(new Date(v).getTime()));
  const asOf = stamp ? new Date(stamp) : (ctx.fetchedAt ?? ctx.now);
  if (ctx.now.getTime() - asOf.getTime() > MAX_STAMP_AGE_MS) return null;

  const m7 = positive(g['marketPrice7Day']) ? g['marketPrice7Day'] : value;
  const recency = daysUsed <= 7 ? 1 : daysUsed <= 14 ? 0.85 : 0.7;
  return {
    value,
    low: Math.min(m7, value),
    high: Math.max(m7, value),
    saleCount,
    windowDays: daysUsed,
    confidence: Math.round((0.4 * Math.min(1, saleCount / 8) + 0.3 * recency + 0.3 * (confidence === 'high' ? 1 : 0.7)) * 1000) / 1000,
    asOf,
    sourceName: 'ppt',
  };
}

/**
 * Atomically reserves `n` credits for a UTC day: one statement, so concurrent callers cannot overspend. The insert
 * branch refuses a first reservation above the cap; the conflict branch refuses one that would pass it. true = reserved.
 */
export async function reservePptCredits(db: Db, day: string, n: number, cap: number): Promise<boolean> {
  const { rows } = await db.query(
    `insert into vendor_credits (provider, day, credits)
     select $1::text, $2::date, $3::int where $3::int <= $4::int
     on conflict (provider, day) do update set credits = vendor_credits.credits + $3::int
       where vendor_credits.credits + $3::int <= $4::int
     returning credits`,
    [PROVIDER, day, n, cap],
  );
  return rows.length > 0;
}

export interface PptAggregateDeps {
  db: Db;
  client: PptClient;
  /** For the TCGdex id lookup. */
  fetch: typeof fetch;
  now: () => Date;
  /** Credits spendable per UTC day, read on every call so a settings change applies without a restart. */
  dailyCredits: () => Promise<number>;
  log?: Log;
}

/**
 * PokemonPriceTracker free-tier graded sold prices (PPT_PARSER_VERSION), one 2-credit call per card covering every
 * grade. Credits are reserved BEFORE the HTTP call and never refunded, so nothing is reserved while the client's
 * breaker is open or after a 401/403 (latched until the next UTC day). Over the daily cap returns null (logged once
 * per UTC day). A cache row per card in vendor_card_cache holds {tcgplayerId, response}: positive < 24h serves any
 * grade for free (re-checked against the requested id); negative (body null: no/ambiguous tcgplayer id, empty data, 404,
 * wrong card) < 7 days returns null for free; a 'failed' marker (5xx, timeout, network, 429) holds for 1 hour so the
 * same card is not re-paid for. Never throws: any failure logs one key-free warn line and returns null so the comps
 * path runs.
 */
export function pptAggregateSource(deps: PptAggregateDeps): AggregatePriceSource {
  let budgetLoggedDay = '';
  let authBlockedDay = '';
  async function writeCache(cardId: string, now: Date, entry: { tcgplayerId: string; response: unknown } | null, kind: string | null = null): Promise<void> {
    await deps.db.query(
      `insert into vendor_card_cache (provider, card_id, fetched_at, body, kind) values ($1, $2, $3, $4::jsonb, $5)
       on conflict (provider, card_id) do update
         set fetched_at = excluded.fetched_at, body = excluded.body, kind = excluded.kind`,
      [PROVIDER, cardId, now, entry === null ? null : JSON.stringify(entry), kind],
    );
  }
  return {
    async fetchAggregate(key: ValuationKey & { gradeLabel?: Key['gradeLabel'] }): Promise<AggregatePrice | null> {
      if (key.gradeLabel) return null;
      try {
        const now = deps.now();
        const day = now.toISOString().slice(0, 10);
        const cached = (
          await deps.db.query<{ fetched_at: string | Date; body: unknown; kind: string | null }>(
            'select fetched_at, body, kind from vendor_card_cache where provider = $1 and card_id = $2', [PROVIDER, key.cardId],
          )
        ).rows[0];
        if (cached) {
          const fetchedAt = new Date(cached.fetched_at);
          const age = now.getTime() - fetchedAt.getTime();
          const entry = cached.body as { tcgplayerId?: unknown; response?: unknown } | null;
          if (entry !== null && age < POSITIVE_TTL_MS) {
            return typeof entry.tcgplayerId === 'string'
              ? parsePptCard(entry.response, key, { now, tcgplayerId: entry.tcgplayerId, fetchedAt })
              : null;
          }
          if (entry === null && cached.kind === 'failed' && age < FAILED_TTL_MS) return null;
          if (entry === null && cached.kind !== 'failed' && age < NEGATIVE_TTL_MS) return null;
        }
        if (authBlockedDay === day) return null;

        const ids = await tcgplayerIds(deps.fetch, key.cardId);
        if (ids.length !== 1) {
          await writeCache(key.cardId, now, null);
          return null;
        }
        const tcgplayerId = ids[0]!;

        if (deps.client.isOpen()) {
          deps.log?.('warn', 'ppt unavailable (breaker open), using comps', { cardId: key.cardId });
          return null;
        }
        if (!(await reservePptCredits(deps.db, day, CALL_COST, await deps.dailyCredits()))) {
          if (budgetLoggedDay !== day) {
            budgetLoggedDay = day;
            deps.log?.('warn', 'ppt daily credit budget exhausted', { day });
          }
          return null;
        }

        let body: { data?: unknown };
        try {
          body = await deps.client.get<{ data?: unknown }>('/cards', {
            tcgPlayerId: tcgplayerId, includeEbay: 'true', days: String(WINDOW_DAYS),
          });
        } catch (err) {
          const status = err instanceof PptHttpError ? err.status : undefined;
          if (status === 404) {
            await writeCache(key.cardId, now, null);
            return null;
          }
          if (status === 401 || status === 403) {
            authBlockedDay = day;
            deps.log?.('error', 'ppt rejected the API key, pausing ppt until the next UTC day', { status });
            return null;
          }
          // No message: errors can carry request details. The comps path still runs.
          if (err instanceof PptUnavailableError) {
            deps.log?.('warn', 'ppt unavailable (breaker open), using comps', { cardId: key.cardId });
          } else {
            deps.log?.('warn', 'ppt card fetch failed, using comps', { cardId: key.cardId, status });
            await writeCache(key.cardId, now, null, 'failed');
          }
          return null;
        }
        if (!identifiedCard(body, tcgplayerId)) {
          deps.log?.('warn', 'ppt response is not the requested card', { cardId: key.cardId });
          await writeCache(key.cardId, now, null);
          return null;
        }
        await writeCache(key.cardId, now, { tcgplayerId, response: body });
        return parsePptCard(body, key, { now, tcgplayerId });
      } catch {
        // No message: errors can carry request details. A throw would fail the valuation and burn eval attempts.
        deps.log?.('warn', 'ppt lookup failed, using comps', { cardId: key.cardId });
        return null;
      }
    },
  };
}
