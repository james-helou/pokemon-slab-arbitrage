import type { Db } from '../db/db.js';
import type { Log } from '../log.js';
import { upsertCards } from './catalog-repo.js';
import { fetchAllCards, type ClientOptions } from './tcgdex-client.js';

const BATCH = 1000;
const MAX_SKIPPED_RATIO = 0.05;

export interface SyncResult {
  cards: number;
  skippedSets: string[];
  removed: number;
}

export interface SyncOptions extends ClientOptions {
  /** Throw (writing nothing) when more than this share of attempted sets were skipped. Default 5%. */
  maxSkippedRatio?: number;
}

export function skippedTooMany(skipped: number, attempted: number, maxRatio = MAX_SKIPPED_RATIO): boolean {
  return attempted > 0 && skipped / attempted > maxRatio;
}

const REFS = ['listing_matches', 'comps', 'valuations', 'recommendations'];
const UNREFERENCED = REFS.map((t) => `not exists (select 1 from ${t} r where r.card_id = cards.id)`).join(' and ');

/** Deletes cards absent from this sync (old id formats, excluded series) unless a row references them. */
async function removeStale(db: Db, keepIds: string[], log: Log): Promise<number> {
  const { rows: kept } = await db.query<{ id: string }>(
    `select id from cards where id <> all($1::text[]) and not (${UNREFERENCED}) order by id`,
    [keepIds],
  );
  if (kept.length > 0) {
    log('warn', 'stale catalog rows kept because they are referenced', { count: kept.length, ids: kept.map((r) => r.id).slice(0, 50) });
  }
  const { rows } = await db.query<{ id: string }>(
    `delete from cards where id <> all($1::text[]) and ${UNREFERENCED} returning id`,
    [keepIds],
  );
  return rows.length;
}

export async function syncCatalog(db: Db, fetchFn: typeof fetch, log: Log, opts: SyncOptions = {}): Promise<SyncResult> {
  const { cards, skippedSets, attemptedSets } = await fetchAllCards(fetchFn, log, opts);
  if (skippedTooMany(skippedSets.length, attemptedSets, opts.maxSkippedRatio)) {
    throw new Error(`catalog sync skipped ${skippedSets.length} of ${attemptedSets} sets (${skippedSets.join(', ')}); not writing a partial catalog`);
  }
  for (let i = 0; i < cards.length; i += BATCH) await upsertCards(db, cards.slice(i, i + BATCH));
  if (skippedSets.length > 0) log('warn', 'catalog sync skipped sets', { skippedSets });
  const removed = skippedSets.length === 0 && cards.length > 0 ? await removeStale(db, cards.map((c) => c.id), log) : 0;
  log('info', 'catalog synced', { cards: cards.length, removed });
  return { cards: cards.length, skippedSets, removed };
}
