import type { Db } from '../db/db.js';
import type { Listing } from '../domain/types.js';
import type { MatchResult } from '../matcher/matcher.js';
import { MATCHER_VERSION } from '../matcher/matcher.js';

export async function upsertListing(db: Db, l: Listing, now: Date): Promise<{ isNew: boolean }> {
  const { rows } = await db.query<{ inserted: boolean }>(
    `insert into listings (source, external_id, title, price, shipping, currency, url, image_url, seller_username,
       seller_feedback_score, seller_feedback_pct, listed_at, aspects, raw, first_seen_at, last_seen_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, $15)
     on conflict (source, external_id) do update set
       title = excluded.title, price = excluded.price, shipping = excluded.shipping, image_url = excluded.image_url,
       aspects = case when excluded.aspects = '{}'::jsonb then listings.aspects else excluded.aspects end,
       raw = excluded.raw, last_seen_at = excluded.last_seen_at
     returning (xmax = 0) as inserted`,
    [
      l.source, l.externalId, l.title, l.price, l.shipping, l.currency, l.url, l.imageUrl, l.sellerUsername,
      l.sellerFeedbackScore, l.sellerFeedbackPct, l.listedAt, JSON.stringify(l.aspects), JSON.stringify(l.raw), now,
    ],
  );
  return { isNew: Boolean(rows[0]!.inserted) };
}

export async function markGone(db: Db, l: Pick<Listing, 'source' | 'externalId'>, now: Date): Promise<void> {
  await db.query(`update listings set gone_at = coalesce(gone_at, $3) where source = $1 and external_id = $2`, [
    l.source, l.externalId, now,
  ]);
}

export async function insertMatch(
  db: Db,
  l: Pick<Listing, 'source' | 'externalId'>,
  r: MatchResult,
  stage: 'title' | 'enriched',
): Promise<void> {
  const m = r.match;
  await db.query(
    `insert into listing_matches (source, external_id, stage, card_id, grader, grade, grade_label, cert, confidence,
       reasons, matcher_version)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
    [
      l.source, l.externalId, stage, m?.cardId ?? null, m?.grader ?? null, m?.grade ?? null, m?.gradeLabel ?? null,
      m?.cert ?? null, m?.confidence ?? null, JSON.stringify(r.reasons), m?.matcherVersion ?? MATCHER_VERSION,
    ],
  );
}
