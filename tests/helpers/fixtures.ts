import type { Db } from '../../src/db/db.js';
import { upsertCards, type CardRow } from '../../src/catalog/catalog-repo.js';

export const CHARIZARD_151: CardRow = {
  id: 'sv3pt5-199', name: 'Charizard ex', number: '199', setId: 'sv3pt5', setName: '151', setPrintedTotal: 165,
};

export async function seedCards(db: Db, cards: CardRow[] = [CHARIZARD_151]): Promise<void> {
  await upsertCards(db, cards);
}

import type { EbayItem, EbayItemSummary } from '../../src/sources/ebay/ebay-client.js';

export const SUMMARY: EbayItemSummary = {
  itemId: 'v1|111|0',
  title: 'PSA 10 Charizard ex 199/165 151 Special Illustration Rare',
  price: { value: '350.00', currency: 'USD' },
  shippingOptions: [{ shippingCost: { value: '5.00', currency: 'USD' } }],
  itemWebUrl: 'https://www.ebay.com/itm/111',
  image: { imageUrl: 'https://i.ebayimg.com/111.jpg' },
  seller: { username: 'goodseller', feedbackScore: 500, feedbackPercentage: '99.8' },
  itemCreationDate: '2026-10-03T11:58:00.000Z',
};

export const ITEM: EbayItem = {
  ...SUMMARY,
  localizedAspects: [
    { name: 'Professional Grader', value: 'Professional Sports Authenticator (PSA)' },
    { name: 'Grade', value: '10' },
    { name: 'Certification Number', value: '12345678' },
    { name: 'Language', value: 'English' },
  ],
  estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'IN_STOCK' }],
};
