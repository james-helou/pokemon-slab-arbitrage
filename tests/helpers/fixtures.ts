import type { Db } from '../../src/db/db.js';
import { upsertCards, type CardRow } from '../../src/catalog/catalog-repo.js';

export const CHARIZARD_151: CardRow = {
  id: 'sv3pt5-199', name: 'Charizard ex', number: '199', setId: 'sv3pt5', setName: '151', setPrintedTotal: 165,
};

export async function seedCards(db: Db, cards: CardRow[] = [CHARIZARD_151]): Promise<void> {
  await upsertCards(db, cards);
}
