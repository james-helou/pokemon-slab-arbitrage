import type { ValuationKey } from '../domain/types.js';
import type { AggregatePrice, AggregatePriceSource } from '../oracle/aggregate-source.js';
import type { PoketraceClient } from './client.js';

type Key = Parameters<AggregatePriceSource['fetchAggregate']>[0];

interface TierPrice {
  avg?: number;
  low?: number;
  high?: number;
  saleCount?: number;
  median7d?: number;
  median30d?: number;
  confidence?: 'high' | 'medium' | 'low';
}

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
}

/** US eBay sold aggregates from PokeTrace's card detail. Median30d, else median7d, else avg. */
export function poketraceAggregateSource(deps: PoketraceAggregateDeps): AggregatePriceSource {
  return {
    async fetchAggregate(key: ValuationKey & { gradeLabel?: Key['gradeLabel'] }): Promise<AggregatePrice | null> {
      const tier = tierKey(key);
      if (!tier) return null;
      const id = await deps.resolveId(key.cardId);
      if (!id) return null;
      const { data } = await deps.client.get<{ data?: { lastUpdated?: string; prices?: Record<string, Record<string, TierPrice>> } }>(
        `/cards/${encodeURIComponent(id)}`,
      );
      const p = data?.prices?.ebay?.[tier];
      if (!p) return null;
      const picked: [number | undefined, number][] = [[p.median30d, 30], [p.median7d, 7], [p.avg, 30]];
      const hit = picked.find(([v]) => typeof v === 'number' && v > 0);
      if (!hit) return null;
      const [value, windowDays] = hit as [number, number];
      const saleCount = p.saleCount ?? 0;
      return {
        value, low: p.low ?? value, high: p.high ?? value, saleCount, windowDays,
        confidence: confidenceOf(saleCount, windowDays, p.confidence),
        asOf: data?.lastUpdated ? new Date(data.lastUpdated) : deps.now(),
        sourceName: 'poketrace',
      };
    },
  };
}
