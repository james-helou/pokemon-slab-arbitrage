import type { Db } from '../db/db.js';
import type { ValuationKey } from '../domain/types.js';
import type { Log } from '../log.js';
import type { AggregatePriceSource } from '../oracle/aggregate-source.js';
import { round2 } from '../scoring/fees.js';

export interface SourceValue { name: string; value: number; saleCount: number; asOf: Date }
/** null = the source has no usable value; 'deferred' = it could not try this time (budget, outage), so unknown. */
export type SourceReader = (key: ValuationKey) => Promise<SourceValue | null | 'deferred'>;
export interface MarketValue { value: number; sources: SourceValue[] }

const OWN_SALES_WINDOW_DAYS = 90;

/**
 * Highest usable source value; null when no source has one. 'deferred' when any reader could not try: the value is a
 * max, so a missing guide could only raise it, and the caller must not decide on the rest. A reader that throws is
 * logged and skipped.
 */
export async function marketValue(
  key: ValuationKey, readers: SourceReader[], log: Log,
): Promise<MarketValue | null | 'deferred'> {
  const sources: SourceValue[] = [];
  let deferred = false;
  for (const read of readers) {
    try {
      const v = await read(key);
      if (v === 'deferred') deferred = true;
      else if (v && Number.isFinite(v.value) && v.value > 0) sources.push(v);
    } catch (err) {
      log('warn', 'market value source failed', { ...key, err: err instanceof Error ? err.message : String(err) });
    }
  }
  if (deferred) return 'deferred';
  if (sources.length === 0) return null;
  return { value: Math.max(...sources.map((s) => s.value)), sources };
}

/** PPT, undiscounted (no Best Offer discount: for "the bid beats every guide" the higher number is the safe one). */
export function pptReader(aggregate: AggregatePriceSource, minSales: number): SourceReader {
  return async (key) => {
    let deferred = false;
    const a = await aggregate.fetchAggregate(key, { onDeferred: () => { deferred = true; } });
    if (!a && deferred) return 'deferred';
    if (!a || a.saleCount < minSales) return null;
    return { name: a.sourceName, value: a.value, saleCount: a.saleCount, asOf: a.asOf };
  };
}

/** Median of our own recorded sales (disappearing BINs + watched auction results), last 90 days, >= minSales. */
export function ownSalesReader(db: Db, now: () => Date, minSales: number): SourceReader {
  return async (key) => {
    const since = new Date(now().getTime() - OWN_SALES_WINDOW_DAYS * 86_400_000);
    const { rows } = await db.query<{ price: string; sold_at: string | Date }>(
      `select price, sold_at from comps
       where card_id = $1 and grader = $2 and grade = $3 and sold_at >= $4
         and kind in ('disappearing_bin', 'auction_result') and source_ref not like 'fixture:%'`,
      [key.cardId, key.grader, key.grade, since],
    );
    if (rows.length === 0 || rows.length < minSales) return null;
    // Work in cents so the even-count mean of two prices rounds like a price, not like a float.
    const cents = rows.map((r) => Math.round(Number(r.price) * 100)).sort((a, b) => a - b);
    const mid = cents.length >> 1;
    const median = cents.length % 2 ? cents[mid]! : Math.round((cents[mid - 1]! + cents[mid]!) / 2);
    const asOf = new Date(Math.max(...rows.map((r) => new Date(r.sold_at).getTime())));
    return { name: 'own_sales', value: round2(median / 100), saleCount: rows.length, asOf };
  };
}

/** Watch readers: PPT (when an aggregate source is wired) and our own sales. Built per run so minSales is current. */
export function buildWatchReaders(o: {
  db: Db; now: () => Date; minSales: number; aggregate?: AggregatePriceSource | undefined;
}): SourceReader[] {
  return [
    ...(o.aggregate ? [pptReader(o.aggregate, o.minSales)] : []),
    ownSalesReader(o.db, o.now, o.minSales),
  ];
}
