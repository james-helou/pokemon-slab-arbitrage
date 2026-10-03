import type { Db } from '../db/db.js';
import type { Log } from '../log.js';
import { upsertCards } from './catalog-repo.js';
import { fetchAllCards } from './pokemontcg-client.js';

export async function syncCatalog(db: Db, fetchFn: typeof fetch, apiKey: string | undefined, log: Log): Promise<number> {
  let total = 0;
  for await (const page of fetchAllCards(fetchFn, apiKey)) {
    await upsertCards(
      db,
      page.map((c) => ({
        id: c.id, name: c.name, number: c.number, setId: c.set.id, setName: c.set.name,
        setPrintedTotal: c.set.printedTotal ?? null,
      })),
    );
    total += page.length;
    log('info', 'catalog page synced', { total });
  }
  return total;
}
