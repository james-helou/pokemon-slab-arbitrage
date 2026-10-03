import type { Db } from '../db/db.js';
import type { Log } from '../log.js';
import { upsertCards } from './catalog-repo.js';
import { fetchAllCards, type ClientOptions } from './tcgdex-client.js';

const BATCH = 1000;

export interface SyncResult {
  cards: number;
  skippedSets: string[];
}

export async function syncCatalog(db: Db, fetchFn: typeof fetch, log: Log, opts?: ClientOptions): Promise<SyncResult> {
  const { cards, skippedSets } = await fetchAllCards(fetchFn, log, opts);
  for (let i = 0; i < cards.length; i += BATCH) await upsertCards(db, cards.slice(i, i + BATCH));
  if (skippedSets.length > 0) log('warn', 'catalog sync skipped sets', { skippedSets });
  log('info', 'catalog synced', { cards: cards.length });
  return { cards: cards.length, skippedSets };
}
