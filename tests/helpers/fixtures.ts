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

import type { NewRecommendation } from '../../src/ledger/ledger-repo.js';

export function makeNewRecommendation(overrides: Partial<NewRecommendation> = {}): NewRecommendation {
  return {
    source: 'ebay',
    externalId: 'v1|111|0',
    cardId: 'sv3pt5-199',
    grader: 'PSA',
    grade: 10,
    cert: '12345678',
    listingSnapshot: {
      title: SUMMARY.title, url: SUMMARY.itemWebUrl, imageUrl: 'https://i.ebayimg.com/111.jpg',
      price: 350, shipping: 5, sellerUsername: 'goodseller', sellerFeedbackScore: 500,
    },
    cardSnapshot: { name: 'Charizard ex', setName: '151', number: '199' },
    valuationSnapshot: {
      cardId: 'sv3pt5-199', grader: 'PSA', grade: 10, value: 600, low: 592.5, high: 607.5, compCount: 6,
      newestCompAgeDays: 1, confidence: 0.893, compsSource: 'fixture', oracleVersion: 'v1.0.0',
      computedAt: '2026-10-03T12:00:00.000Z',
    },
    channelNets: [
      { channel: 'ebay', salePrice: 600, net: 133.75, daysToSell: 10 },
      { channel: 'tcgplayer', salePrice: 570, net: 107.82, daysToSell: 21 },
    ],
    bestChannel: 'ebay',
    buyTotal: 379.85,
    bestNet: 133.75,
    roi: 0.3521,
    confidence: 0.848,
    rank: 113.42,
    redFlags: [],
    routedTo: 'alerts',
    scorerVersion: 'v1.0.0',
    matcherVersion: 'v1.0.0',
    oracleVersion: 'v1.0.0',
    ...overrides,
  };
}
