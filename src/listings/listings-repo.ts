import type { Db } from '../db/db.js';
import type { GoneReason, Listing, ListingOrigin } from '../domain/types.js';
import type { MatchResult } from '../matcher/matcher.js';
import { MATCHER_VERSION } from '../matcher/matcher.js';

export async function upsertListing(db: Db, l: Listing, now: Date): Promise<{ isNew: boolean }> {
  const { rows } = await db.query<{ inserted: boolean }>(
    `insert into listings (source, external_id, title, price, shipping, currency, url, image_url, seller_username,
       seller_feedback_score, seller_feedback_pct, listed_at, aspects, raw, first_seen_at, last_seen_at,
       origin, buying_options, original_price, original_currency)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, $15,
       $16, $17::jsonb, $18, $19)
     on conflict (source, external_id) do update set
       title = excluded.title, price = excluded.price, shipping = excluded.shipping, image_url = excluded.image_url,
       aspects = case when excluded.aspects = '{}'::jsonb then listings.aspects else excluded.aspects end,
       buying_options = coalesce(excluded.buying_options, listings.buying_options),
       original_price = excluded.original_price, original_currency = excluded.original_currency,
       raw = excluded.raw, last_seen_at = excluded.last_seen_at, miss_count = 0,
       gone_at = case when listings.gone_reason = 'window_miss' then null else listings.gone_at end,
       gone_reason = case when listings.gone_reason = 'window_miss' then null else listings.gone_reason end
     returning (xmax = 0) as inserted`,
    [
      l.source, l.externalId, l.title, l.price, l.shipping, l.currency, l.url, l.imageUrl, l.sellerUsername,
      l.sellerFeedbackScore, l.sellerFeedbackPct, l.listedAt, JSON.stringify(l.aspects), JSON.stringify(l.raw), now,
      l.origin ?? 'us_bin', l.buyingOptions ? JSON.stringify(l.buyingOptions) : null, l.originalPrice ?? null,
      l.originalCurrency ?? null,
    ],
  );
  return { isNew: Boolean(rows[0]!.inserted) };
}

/** The scan that first stored this listing; null = not stored. */
export async function listingOrigin(db: Db, l: Pick<Listing, 'source' | 'externalId'>): Promise<ListingOrigin | null> {
  const { rows } = await db.query<{ origin: ListingOrigin }>(
    'select origin from listings where source = $1 and external_id = $2',
    [l.source, l.externalId],
  );
  return rows[0]?.origin ?? null;
}

/**
 * Sets gone_at once (first detection wins) and records why. A confirmed reason (out_of_stock / not_found)
 * replaces an unconfirmed window_miss, but is never overwritten itself.
 */
export async function markGone(
  db: Db,
  l: Pick<Listing, 'source' | 'externalId'>,
  now: Date,
  reason: GoneReason = 'not_found',
): Promise<void> {
  await db.query(
    `update listings set gone_at = coalesce(gone_at, $3),
       gone_reason = case when gone_reason is null or gone_reason = 'window_miss' then $4 else gone_reason end
     where source = $1 and external_id = $2`,
    [l.source, l.externalId, now, reason],
  );
}

/** A getItem confirmed the listing is still live: clear misses, revive an unconfirmed gone state, start the recheck cooldown. */
export async function markSeenLive(db: Db, l: Pick<Listing, 'source' | 'externalId'>, now: Date): Promise<void> {
  await db.query(
    `update listings set miss_count = 0, checked_at = $3, last_seen_at = greatest(last_seen_at, $3),
       gone_at = case when gone_reason = 'window_miss' then null else gone_at end,
       gone_reason = case when gone_reason = 'window_miss' then null else gone_reason end
     where source = $1 and external_id = $2`,
    [l.source, l.externalId, now],
  );
}

/**
 * Newest-first scans return a window of listings whose listed_at is >= the oldest one returned (the floor).
 * Every open listing listed strictly after the floor that this scan did not return gets miss_count + 1.
 * Returns how many listings were bumped.
 */
export async function recordWindowMisses(
  db: Db,
  source: Listing['source'],
  seenIds: string[],
  windowFloor: Date,
  origin: ListingOrigin = 'us_bin',
): Promise<number> {
  const { rows } = await db.query(
    `update listings set miss_count = miss_count + 1
     where source = $1 and gone_at is null and listed_at > $2 and origin = $4
       and external_id not in (select jsonb_array_elements_text($3::jsonb))
     returning external_id`,
    [source, windowFloor, JSON.stringify(seenIds), origin],
  );
  return rows.length;
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

export const MAX_EVAL_ATTEMPTS = 3;

export async function needsEvaluation(db: Db, l: Pick<Listing, 'source' | 'externalId'>): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    `select (evaluated_at is null and eval_attempts < $3) as ok from listings where source = $1 and external_id = $2`,
    [l.source, l.externalId, MAX_EVAL_ATTEMPTS],
  );
  return Boolean(rows[0]?.ok);
}

export async function markEvaluated(db: Db, l: Pick<Listing, 'source' | 'externalId'>, now: Date): Promise<void> {
  await db.query(`update listings set evaluated_at = $3 where source = $1 and external_id = $2`, [
    l.source, l.externalId, now,
  ]);
}

export async function recordEvalFailure(db: Db, l: Pick<Listing, 'source' | 'externalId'>): Promise<void> {
  await db.query(`update listings set eval_attempts = eval_attempts + 1 where source = $1 and external_id = $2`, [
    l.source, l.externalId,
  ]);
}
