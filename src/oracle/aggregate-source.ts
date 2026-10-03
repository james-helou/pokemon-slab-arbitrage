import type { ValuationKey } from '../domain/types.js';

export interface AggregatePrice {
  value: number;
  low: number;
  high: number;
  /** Number of sales behind the aggregate; plays the role of compCount. */
  saleCount: number;
  /** Window the value was computed over (7 or 30). Stands in for the newest comp age, which aggregates don't expose. */
  windowDays: number;
  /** 0..1, same scale as computeValuation's confidence. */
  confidence: number;
  asOf: Date;
  sourceName: string;
}

/** A vendor that returns pre-aggregated sold prices for a graded card instead of individual sales. */
export interface AggregatePriceSource {
  /** null = no usable data for this key. Throwing means the vendor failed; the valuation must fail with it. */
  fetchAggregate(key: ValuationKey & { gradeLabel?: 'pristine' | 'black_label' | null }): Promise<AggregatePrice | null>;
}
