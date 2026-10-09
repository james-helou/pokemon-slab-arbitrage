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
export const PPT_PARSER_VERSION = 'v0-unverified';

/** Candidate grade keys for a grader+grade: psa10 / PSA10 / psa_10 / PSA_10, and 9.5 as 9_5 or 9.5. */
function gradeKeys(key: Pick<Key, 'grader' | 'grade'>): string[] {
  const g = String(key.grade);
  const grades = [...new Set([g, g.replace('.', '_')])];
  const out: string[] = [];
  for (const sep of ['', '_']) {
    for (const gr of grades) {
      const base = `${key.grader}${sep}${gr}`;
      out.push(base.toLowerCase(), base.toUpperCase());
    }
  }
  return [...new Set(out)];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
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
 * Pulls a graded price out of a PPT card response. null for labelled grades, a response that is not exactly the
 * requested card, a non-USD currency, a stamp older than 72h, a missing grade object, or no usable price/count.
 * TODO(verify) against a real response (npm run ppt:probe), three unknowns: (1) the grade key format (psa10 vs PSA10
 * vs psa_10), (2) whether salesCount is a lifetime count or the 30 day window, (3) the exact field names. While the
 * parser is unverified a finite dailyVolume7Day is required and salesCount is clamped by dailyVolume7Day * 30, so a
 * lifetime count cannot pass as a 30 day one.
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
  const byGrade = ebay['salesByGrade'];
  let g: Record<string, unknown> | undefined;
  for (const container of [byGrade, ebay]) {
    if (!isObj(container)) continue;
    const hit = gradeKeys(key).map((k) => container[k]).find(isObj);
    if (hit) { g = hit; break; }
  }
  if (!g) return null;
  const value = positive(g['medianPrice']) ? g['medianPrice'] : positive(g['averagePrice']) ? g['averagePrice'] : null;
  if (value === null) return null;
  const sales = count(g['salesCount']) ? g['salesCount'] : count(g['count']) ? g['count'] : null;
  if (sales === null) return null;
  const vol = g['dailyVolume7Day'];
  const hasVol = typeof vol === 'number' && Number.isFinite(vol) && vol >= 0;
  if (PPT_PARSER_VERSION === 'v0-unverified' && !hasVol) return null;
  const saleCount = hasVol ? Math.min(sales, Math.round(vol * WINDOW_DAYS)) : sales;
  const stamp = [card['lastUpdated'], card['updatedAt'], ebay['lastUpdated'], ebay['updatedAt']]
    .find((v): v is string => typeof v === 'string' && !Number.isNaN(new Date(v).getTime()));
  const asOf = stamp ? new Date(stamp) : (ctx.fetchedAt ?? ctx.now);
  if (ctx.now.getTime() - asOf.getTime() > MAX_STAMP_AGE_MS) return null;
  const min = positive(g['minPrice']) ? g['minPrice'] : value;
  const max = positive(g['maxPrice']) ? g['maxPrice'] : value;
  return {
    value,
    low: Math.min(min, value),
    high: Math.max(max, value),
    saleCount,
    windowDays: WINDOW_DAYS,
    // Same shape as poketrace's: 0.4 count, 0.3 recency (30d window = 0.7), 0.3 vendor term (fixed 0.7, no label here).
    confidence: Math.round((0.4 * Math.min(1, saleCount / 8) + 0.3 * 0.7 + 0.3 * 0.7) * 1000) / 1000,
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
