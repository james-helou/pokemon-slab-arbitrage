import type { Db } from '../db/db.js';
import type { Grader } from '../domain/types.js';

export type SoldCheckStatus = 'ok' | 'no_results' | 'blocked' | 'error';

export interface SoldCheckKey {
  cardId: string;
  grader: Grader;
  grade: number;
}

export interface NewSoldCheck extends SoldCheckKey {
  query: string;
  status: SoldCheckStatus;
  fetchedAt: Date;
  saleCount: number;
  median: number | null;
  low: number | null;
  high: number | null;
  newestSoldAt: Date | null;
  matchedTitles: string[];
  parserVersion: string;
}

export interface StoredSoldCheck extends NewSoldCheck {
  id: number;
}

const MAX_TITLES = 30;
const MAX_TITLE_LEN = 120;

/** Append-only. Matched titles are capped at 30 entries of at most 120 chars. */
export async function insertSoldCheck(db: Db, c: NewSoldCheck): Promise<number> {
  const titles = c.matchedTitles.slice(0, MAX_TITLES).map((t) => t.slice(0, MAX_TITLE_LEN));
  const { rows } = await db.query<{ id: unknown }>(
    `insert into sold_checks (card_id, grader, grade, query, status, fetched_at, sale_count, median, low, high,
       newest_sold_at, matched_titles, parser_version)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     returning id`,
    [
      c.cardId, c.grader, c.grade, c.query, c.status, c.fetchedAt, c.saleCount, c.median, c.low, c.high,
      c.newestSoldAt, JSON.stringify(titles), c.parserVersion,
    ],
  );
  return Number(rows[0]!.id);
}

const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function toStored(r: Record<string, unknown>): StoredSoldCheck {
  return {
    id: Number(r.id),
    cardId: String(r.card_id),
    grader: r.grader as Grader,
    grade: Number(r.grade),
    query: String(r.query),
    status: r.status as SoldCheckStatus,
    fetchedAt: new Date(r.fetched_at as string),
    saleCount: Number(r.sale_count),
    median: numOrNull(r.median),
    low: numOrNull(r.low),
    high: numOrNull(r.high),
    newestSoldAt: r.newest_sold_at ? new Date(r.newest_sold_at as string) : null,
    matchedTitles: (r.matched_titles as unknown[]).map(String),
    parserVersion: String(r.parser_version),
  };
}

/** Newest 'ok' row for this card+grader+grade fetched within maxAgeHours before now. */
export async function latestOkSoldCheck(
  db: Db, key: SoldCheckKey, maxAgeHours: number, now: Date,
): Promise<StoredSoldCheck | null> {
  const since = new Date(now.getTime() - maxAgeHours * 3_600_000);
  const { rows } = await db.query<Record<string, unknown>>(
    `select * from sold_checks
     where card_id = $1 and grader = $2 and grade = $3 and status = 'ok'
       and fetched_at >= $4 and fetched_at <= $5
     order by fetched_at desc, id desc
     limit 1`,
    [key.cardId, key.grader, key.grade, since, now],
  );
  return rows[0] ? toStored(rows[0]) : null;
}

/** Every fetch (any status, any key) at or after `since`; the daily-cap budget. */
export async function countSoldChecksSince(db: Db, since: Date): Promise<number> {
  const { rows } = await db.query<{ n: unknown }>(`select count(*) as n from sold_checks where fetched_at >= $1`, [since]);
  return Number(rows[0]!.n);
}
