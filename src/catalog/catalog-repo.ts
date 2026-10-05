import type { Db } from '../db/db.js';
import type { SetRef } from '../matcher/set-names.js';

export interface CardRow {
  id: string;
  name: string;
  number: string;
  setId: string;
  setName: string;
  setPrintedTotal: number | null;
}

export interface CardCandidate {
  id: string;
  name: string;
  number: string;
  setPrintedTotal: number | null;
}

export async function upsertCards(db: Db, cards: CardRow[]): Promise<void> {
  if (cards.length === 0) return;
  const params: unknown[] = [];
  const values = cards.map((c, i) => {
    const b = i * 6;
    params.push(c.id, c.name, c.number, c.setId, c.setName, c.setPrintedTotal);
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`;
  });
  await db.query(
    `insert into cards (id, name, number, set_id, set_name, set_printed_total) values ${values.join(', ')}
     on conflict (id) do update set name = excluded.name, number = excluded.number, set_id = excluded.set_id,
       set_name = excluded.set_name, set_printed_total = excluded.set_printed_total, updated_at = now()`,
    params,
  );
}

const CANON_NUMBER = (col: string) => `regexp_replace(upper(${col}), '^([A-Z]*)0+([0-9])', '\\1\\2')`;

/**
 * Cards with this number; when the listing's denominator is numeric it must equal the set's printed total. Without a
 * total (a bare Card Number aspect, or the cross-set uniqueness check of the label path) numbers compare ignoring zero
 * padding, like findCandidatesInSet; with a total the indexed exact comparison is kept.
 */
export async function findCandidates(db: Db, number: string, total: string | null): Promise<CardCandidate[]> {
  const numericTotal = total !== null && /^\d+$/.test(total) ? Number(total) : null;
  const numberClause = numericTotal !== null ? 'upper(number) = upper($1)' : `${CANON_NUMBER('number')} = ${CANON_NUMBER('$1')}`;
  const { rows } = await db.query<{ id: string; name: string; number: string; set_printed_total: number | null }>(
    `select id, name, number, set_printed_total from cards
     where ${numberClause} and language = 'en' ${numericTotal !== null ? 'and set_printed_total = $2' : ''}
     order by id`,
    numericTotal !== null ? [number, numericTotal] : [number],
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, number: r.number,
    setPrintedTotal: r.set_printed_total === null ? null : Number(r.set_printed_total),
  }));
}

/** Promo numbers compare ignoring zero padding: SWSH020 and SWSH20 are the same card, as are 085 and 85. */
function canonPromo(n: string): string {
  const m = /^([A-Z]*)0*(\d+)$/.exec(n.replace(/\s+/g, '').toUpperCase());
  return m ? `${m[1]}${m[2]}` : n.toUpperCase();
}

/**
 * Cards of one set with this number, ignoring zero padding ("095" = "95", "SWSH020" = "SWSH20"). Used for promo codes
 * (no printed total) and for PSA label titles whose set is named in the title.
 */
export async function findCandidatesInSet(db: Db, setId: string, number: string): Promise<CardCandidate[]> {
  const { rows } = await db.query<{ id: string; name: string; number: string; set_printed_total: number | null }>(
    `select id, name, number, set_printed_total from cards where set_id = $1 and language = 'en' order by id`,
    [setId],
  );
  const want = canonPromo(number);
  return rows
    .filter((r) => canonPromo(r.number) === want)
    .map((r) => ({
      id: r.id, name: r.name, number: r.number,
      setPrintedTotal: r.set_printed_total === null ? null : Number(r.set_printed_total),
    }));
}

const setCache = new WeakMap<Db, { fingerprint: string; sets: SetRef[] }>();

/** Drops the cached set list for this db. syncCatalog calls it after writing. */
export function invalidateSetCache(db: Db): void {
  setCache.delete(db);
}

/**
 * Every English set in the catalog (id + name), for resolving a set named in a listing title. Memoized per db handle
 * and keyed on a cheap catalog fingerprint (row count + newest updated_at), so a sync run by another process is seen
 * on the next call; an in-process sync also invalidates it directly.
 */
export async function listSets(db: Db): Promise<SetRef[]> {
  const { rows: fp } = await db.query<{ n: number; u: string | null }>(
    `select count(*)::int as n, max(updated_at)::text as u from cards where language = 'en'`,
  );
  const fingerprint = `${fp[0]?.n ?? 0}|${fp[0]?.u ?? ''}`;
  const hit = setCache.get(db);
  if (hit && hit.fingerprint === fingerprint) return hit.sets;
  const { rows } = await db.query<{ id: string; name: string }>(
    `select set_id as id, min(set_name) as name from cards where language = 'en' group by set_id order by set_id`,
  );
  const sets = rows.map((r) => ({ id: r.id, name: r.name }));
  setCache.set(db, { fingerprint, sets });
  return sets;
}

export async function getCard(db: Db, id: string): Promise<CardRow | null> {
  const { rows } = await db.query<Record<string, unknown>>('select * from cards where id = $1', [id]);
  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id), name: String(r.name), number: String(r.number), setId: String(r.set_id),
    setName: String(r.set_name), setPrintedTotal: r.set_printed_total === null ? null : Number(r.set_printed_total),
  };
}
