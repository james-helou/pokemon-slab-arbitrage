import type { Db } from '../db/db.js';

/** A comp is written only when the sale time is known to within this many hours (gone_at - last_seen_at). */
export const MAX_SOLD_AT_UNCERTAINTY_HOURS = 24;
const WINDOW_DAYS = 90;

/**
 * Writes one disappearing_bin comp per confirmed-gone listing (out_of_stock or not_found) whose latest match
 * (enriched preferred over title) is confident and has no special grade label.
 * price = last seen list price (shipping excluded); sold_at = gone_at. The oracle applies boDiscount to this kind.
 * Listings that were themselves recommended are excluded (flagged as underpriced, they would bias values down).
 * source_ref = ebay:<externalId>:<gone_reason>, so 404-derived comps can be filtered later without a migration.
 * A confirmed gone_reason is never overwritten, so the ref is stable per listing and the insert is idempotent
 * through comps unique (kind, source_ref). Returns how many comps were written.
 */
export async function recordDisappearingComps(db: Db, minMatchConfidence: number, now: Date): Promise<number> {
  const { rows } = await db.query(
    `insert into comps (card_id, grader, grade, price, sold_at, kind, source_ref)
     select m.card_id, m.grader, m.grade, l.price, l.gone_at, 'disappearing_bin',
            'ebay:' || l.external_id || ':' || l.gone_reason
     from listings l
     join lateral (
       select card_id, grader, grade, confidence, grade_label from listing_matches lm
       where lm.source = l.source and lm.external_id = l.external_id
       order by (lm.stage = 'enriched') desc, lm.id desc
       limit 1
     ) m on true
     where l.source = 'ebay' and l.currency = 'USD'
       and l.gone_reason in ('out_of_stock', 'not_found')
       and l.gone_at >= $1
       and l.last_seen_at <= l.gone_at
       and l.gone_at - l.last_seen_at <= make_interval(hours => ${MAX_SOLD_AT_UNCERTAINTY_HOURS})
       and m.card_id is not null and m.grader is not null and m.grade is not null
       and m.grade_label is null
       and m.confidence >= $2
       and not exists (select 1 from recommendations r where r.source = l.source and r.external_id = l.external_id)
     on conflict (kind, source_ref) do nothing
     returning id`,
    [new Date(now.getTime() - WINDOW_DAYS * 86_400_000), minMatchConfidence],
  );
  return rows.length;
}
