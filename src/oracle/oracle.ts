import type { Db } from '../db/db.js';
import type { CompKind, Valuation, ValuationKey } from '../domain/types.js';
import type { Settings } from '../settings/settings.js';
import type { AggregatePriceSource } from './aggregate-source.js';
import type { CompsSource } from './comps-source.js';
import { computeValuation, ORACLE_VERSION } from './valuation.js';

export interface OracleDeps {
  db: Db;
  source: CompsSource;
  /** Preferred when it returns enough sales; null falls back to comps, a throw fails the valuation. */
  aggregate?: AggregatePriceSource;
  /**
   * Set when a real vendor is configured: ignores comps rows persisted by the fixture source (source_ref 'fixture:%')
   * and cached valuations built from them, so leftover dev fixtures never feed real valuations.
   */
  excludeFixture?: boolean;
  now: () => Date;
}

function rowToValuation(r: Record<string, unknown>): Valuation {
  return {
    cardId: String(r.card_id), grader: r.grader as Valuation['grader'], grade: Number(r.grade),
    value: Number(r.value), low: Number(r.low), high: Number(r.high), compCount: Number(r.comp_count),
    newestCompAgeDays: Number(r.newest_comp_age_days), confidence: Number(r.confidence),
    compsSource: String(r.comps_source), oracleVersion: String(r.oracle_version), computedAt: new Date(r.computed_at as string),
  };
}

async function persistValuation(db: Db, v: Valuation): Promise<void> {
  await db.query(
    `insert into valuations (card_id, grader, grade, value, low, high, comp_count, newest_comp_age_days, confidence,
       comps_source, oracle_version, computed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [v.cardId, v.grader, v.grade, v.value, v.low, v.high, v.compCount, v.newestCompAgeDays, v.confidence,
      v.compsSource, v.oracleVersion, v.computedAt],
  );
}

/** Throws if the comps source fails; callers must skip the listing (never alert on stale data). */
export async function getValuation(
  deps: OracleDeps,
  key: ValuationKey,
  settings: Pick<Settings, 'valuationMaxAgeHours' | 'boDiscount' | 'minCompCount'>,
): Promise<Valuation | null> {
  const { db } = deps;
  const now = deps.now();
  const freshAfter = new Date(now.getTime() - settings.valuationMaxAgeHours * 3_600_000);
  const cached = await db.query<Record<string, unknown>>(
    `select * from valuations where card_id = $1 and grader = $2 and grade = $3 and computed_at > $4
       and ($5::boolean is not true or comps_source not like '%fixture%')
     order by computed_at desc limit 1`,
    [key.cardId, key.grader, key.grade, freshAfter, deps.excludeFixture ?? false],
  );
  if (cached.rows[0]) return rowToValuation(cached.rows[0]);

  if (deps.aggregate) {
    const a = await deps.aggregate.fetchAggregate(key);
    if (a && a.saleCount >= settings.minCompCount) {
      // eBay sold aggregates include accepted Best Offers at the list price: same discount as non-paid comps.
      const bo = (n: number) => Math.round(n * settings.boDiscount * 100) / 100;
      const v: Valuation = {
        ...key, value: bo(a.value), low: bo(a.low), high: bo(a.high), compCount: a.saleCount, newestCompAgeDays: a.windowDays,
        confidence: a.confidence, compsSource: a.sourceName, oracleVersion: ORACLE_VERSION, computedAt: now,
      };
      await persistValuation(db, v);
      return v;
    }
  }

  for (const c of await deps.source.fetchComps(key)) {
    await db.query(
      `insert into comps (card_id, grader, grade, price, sold_at, kind, source_ref) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (kind, source_ref) do update set price = excluded.price, sold_at = excluded.sold_at`,
      [key.cardId, key.grader, key.grade, c.price, c.soldAt, c.kind, c.sourceRef],
    );
  }

  const since = new Date(now.getTime() - 90 * 86_400_000);
  const { rows } = await db.query<{ price: string; sold_at: string; kind: CompKind }>(
    `select price, sold_at, kind from comps where card_id = $1 and grader = $2 and grade = $3 and sold_at >= $4
       and ($5::boolean is not true or source_ref not like 'fixture:%')`,
    [key.cardId, key.grader, key.grade, since, deps.excludeFixture ?? false],
  );
  const computed = computeValuation(
    rows.map((r) => ({ price: Number(r.price), soldAt: new Date(r.sold_at), kind: r.kind })),
    now,
    { boDiscount: settings.boDiscount, minCompCount: settings.minCompCount },
  );
  if (!computed) return null;

  const v: Valuation = { ...key, ...computed, compsSource: deps.source.name, oracleVersion: ORACLE_VERSION, computedAt: now };
  await persistValuation(db, v);
  return v;
}
