import type { Db } from '../db/db.js';
import type { Log } from '../log.js';

/** Makes sure the card catalog is populated, syncing in-process when empty. Returns false if it still is not. */
export async function ensureCatalog(db: Db, sync: () => Promise<number>, log: Log): Promise<boolean> {
  const count = async () => (await db.query<{ n: number }>('select count(*)::int as n from cards')).rows[0]!.n;
  if ((await count()) > 0) return true;
  log('warn', 'card catalog is empty: running first-boot catalog sync');
  try {
    log('info', 'catalog sync finished', { cards: await sync() });
  } catch (err) {
    log('error', 'catalog sync failed', { message: err instanceof Error ? err.message : String(err) });
    return false;
  }
  if ((await count()) === 0) {
    log('error', 'card catalog is still empty after sync');
    return false;
  }
  return true;
}
