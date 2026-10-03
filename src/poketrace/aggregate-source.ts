import type { ValuationKey } from '../domain/types.js';
import type { Log } from '../log.js';
import type { AggregatePrice, AggregatePriceSource } from '../oracle/aggregate-source.js';
import { PoketraceHttpError, PoketraceUnavailableError, type PoketraceClient } from './client.js';

type Key = Parameters<AggregatePriceSource['fetchAggregate']>[0];

interface TierPrice {
  /** Window undocumented by the vendor: never used as a value. */
  avg?: number;
  low?: number;
  high?: number;
  /** Window undocumented by the vendor (see the TODO at its use). */
  saleCount?: number;
  avg30d?: number;
  median7d?: number;
  median30d?: number;
  confidence?: 'high' | 'medium' | 'low';
}

interface CardDetail {
  market?: string;
  currency?: string;
  lastUpdated?: string;
  prices?: Record<string, Record<string, TierPrice>>;
}

const DEFAULT_MAX_AGE_HOURS = 72;

const VENDOR_CONFIDENCE = { high: 1, medium: 0.7, low: 0.4 } as const;

/** PokeTrace tier key, e.g. PSA_10, CGC_9_5. null for labelled grades (Pristine / Black Label): tier naming is unverified. */
export function tierKey(key: Pick<Key, 'grader' | 'grade' | 'gradeLabel'>): string | null {
  if (key.gradeLabel) return null;
  return `${key.grader}_${String(key.grade).replace('.', '_')}`;
}

/**
 * Same weighting idea as computeValuation: 0.4 count (saleCount/8, capped), 0.3 recency (by window), and 0.3 for
 * the vendor's own confidence label in place of the comp-spread term, which an aggregate can't provide.
 */
function confidenceOf(saleCount: number, windowDays: number, vendor: TierPrice['confidence']): number {
  const countScore = Math.min(1, saleCount / 8);
  const ageScore = windowDays <= 7 ? 1 : windowDays <= 30 ? 0.7 : 0.4;
  const vendorScore = VENDOR_CONFIDENCE[vendor ?? 'low'];
  return Math.round((0.4 * countScore + 0.3 * ageScore + 0.3 * vendorScore) * 1000) / 1000;
}

export interface PoketraceAggregateDeps {
  client: PoketraceClient;
  /** Our card id -> PokeTrace uuid, or null when unmapped (see resolvePoketraceId). */
  resolveId: (cardId: string) => Promise<string | null>;
  now: () => Date;
  /** Card detail whose lastUpdated is older than this is ignored. Default 72. */
  maxAgeHours?: number;
  log?: Log;
  /** Drops a mapping whose PokeTrace card no longer exists (404), e.g. invalidatePoketraceId. */
  invalidateId?: (cardId: string) => Promise<void>;
}

/**
 * Conservative US eBay sold aggregates from PokeTrace's card detail: median30d, else median7d, else avg30d (never the
 * undocumented-window avg). null when the vendor's confidence is low, the data is stale or undated, or the card is not
 * the US market priced in USD (a missing currency counts as not USD). Never throws: a mapping failure or a card detail
 * failure (including PoketraceUnavailableError while the client's breaker is open) logs one key-free warn line and
 * returns null, so the comps path runs. A throw would fail the valuation and burn the listing's eval attempts. A 404
 * invalidates the mapping (best-effort: a failed invalidation is logged) and returns null.
 */
export function poketraceAggregateSource(deps: PoketraceAggregateDeps): AggregatePriceSource {
  const maxAgeMs = (deps.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS) * 3_600_000;
  return {
    async fetchAggregate(key: ValuationKey & { gradeLabel?: Key['gradeLabel'] }): Promise<AggregatePrice | null> {
      const tier = tierKey(key);
      if (!tier) return null;
      let id: string | null;
      try {
        id = await deps.resolveId(key.cardId);
      } catch {
        // No message: errors can carry request details. The comps path still values the listing.
        deps.log?.('warn', 'poketrace mapping failed', { cardId: key.cardId });
        return null;
      }
      if (!id) return null;
      let data: CardDetail | undefined;
      try {
        ({ data } = await deps.client.get<{ data?: CardDetail }>(`/cards/${encodeURIComponent(id)}`));
      } catch (err) {
        if (!(err instanceof PoketraceHttpError && err.status === 404)) {
          // No message: errors can carry request details. The comps path still runs (never disappearing-only).
          if (err instanceof PoketraceUnavailableError) {
            deps.log?.('warn', 'poketrace unavailable (breaker open), using comps', { cardId: key.cardId });
          } else {
            const status = err instanceof PoketraceHttpError ? err.status : undefined;
            deps.log?.('warn', 'poketrace card fetch failed, using comps', { cardId: key.cardId, status });
          }
          return null;
        }
        try {
          await deps.invalidateId?.(key.cardId);
        } catch {
          // No message: errors can carry request details. Still null, so the comps path values the listing.
          deps.log?.('warn', 'poketrace card gone, mapping invalidation failed', { cardId: key.cardId });
          return null;
        }
        deps.log?.('warn', 'poketrace card gone, mapping invalidated', { cardId: key.cardId });
        return null;
      }
      if (!data || data.market !== 'US') return null;
      if (data.currency?.toUpperCase() !== 'USD') return null;

      const asOf = data.lastUpdated ? new Date(data.lastUpdated) : null;
      if (!asOf || Number.isNaN(asOf.getTime())) return null;
      if (deps.now().getTime() - asOf.getTime() > maxAgeMs) return null;

      const p = data.prices?.ebay?.[tier];
      if (!p || p.confidence === 'low') return null;
      const picked: [number | undefined, number][] = [[p.median30d, 30], [p.median7d, 7], [p.avg30d, 30]];
      const hit = picked.find(([v]) => typeof v === 'number' && v > 0);
      if (!hit) return null;
      const [value, windowDays] = hit as [number, number];
      // TODO(verify): the saleCount window is undocumented; check it against a real response before trusting it as the
      // count behind a 30d/7d median. The oracle gates on saleCount >= minCompCount.
      const saleCount = p.saleCount ?? 0;
      return {
        value, low: p.low ?? value, high: p.high ?? value, saleCount, windowDays,
        confidence: confidenceOf(saleCount, windowDays, p.confidence),
        asOf,
        sourceName: 'poketrace',
      };
    },
  };
}
