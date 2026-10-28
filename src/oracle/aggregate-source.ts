import type { ValuationKey } from '../domain/types.js';

export interface AggregatePrice {
  value: number;
  low: number;
  high: number;
  /** Number of sales behind the aggregate; plays the role of compCount. */
  saleCount: number;
  /** Window the value was computed over (7 or 30). Feeds confidence; the oracle takes newestCompAgeDays from asOf. */
  windowDays: number;
  /** 0..1, same scale as computeValuation's confidence. */
  confidence: number;
  asOf: Date;
  sourceName: string;
}

export interface AggregateFetchOptions {
  /**
   * Default true. false = free lookups only: a source with a metered budget (PPT) may serve its cache but must not
   * spend anything. Sources without a budget ignore it.
   */
  spend?: boolean;
  /**
   * Called (before the source returns null) when it could not try: a metered budget or pacing refusal, an open breaker,
   * an id-lookup or vendor outage, a short-lived failure marker. Not called for definitive no-data (no id for the card,
   * no usable price, a cached negative result). Lets a caller that must not mistake "unknown" for "none" retry later.
   * Sources without such states ignore it.
   */
  onDeferred?: () => void;
}

/** A vendor that returns pre-aggregated sold prices for a graded card instead of individual sales. */
export interface AggregatePriceSource {
  /**
   * null = no usable data for this key, including a failed id mapping or a vendor outage, which the source logs; the
   * oracle then falls back to comps. Throwing fails the valuation (and burns one of the listing's eval attempts), so
   * sources should return null for vendor failures. Prices are raw sold prices: the oracle applies the Best Offer
   * discount.
   */
  fetchAggregate(
    key: ValuationKey & { gradeLabel?: 'pristine' | 'black_label' | null },
    opts?: AggregateFetchOptions,
  ): Promise<AggregatePrice | null>;
}
