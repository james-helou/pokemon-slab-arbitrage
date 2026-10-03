import type { Db } from '../db/db.js';
import type { CompKind } from '../domain/types.js';
import type { CompsSource } from './comps-source.js';

/**
 * Comps we recorded ourselves (default: the disappearing-BIN record), read back from the comps table.
 * Note: getValuation already reads every kind from the table after upserting; this source makes the
 * composition explicit and keeps valuations.comps_source honest about what fed the value.
 */
export function ownCompsSource(
  db: Db,
  now: () => Date,
  kinds: CompKind[] = ['disappearing_bin'],
  windowDays = 90,
): CompsSource {
  return {
    name: 'own_db',
    async fetchComps(key) {
      const since = new Date(now().getTime() - windowDays * 86_400_000);
      const { rows } = await db.query<{ price: string; sold_at: string | Date; kind: CompKind; source_ref: string }>(
        `select price, sold_at, kind, source_ref from comps
         where card_id = $1 and grader = $2 and grade = $3 and sold_at >= $4
           and kind in (select jsonb_array_elements_text($5::jsonb))
         order by sold_at desc, source_ref`,
        [key.cardId, key.grader, key.grade, since, JSON.stringify(kinds)],
      );
      return rows.map((r) => ({ price: Number(r.price), soldAt: new Date(r.sold_at), kind: r.kind, sourceRef: r.source_ref }));
    },
  };
}
