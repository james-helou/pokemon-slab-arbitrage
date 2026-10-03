import { createEbayClient } from './ebay-client.js';
import type { Budget } from './budget.js';
import { summaryToListing } from './normalize.js';

const { EBAY_CLIENT_ID, EBAY_CLIENT_SECRET } = process.env;
if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET) throw new Error('EBAY_CLIENT_ID and EBAY_CLIENT_SECRET are required');
const budget: Budget = { limit: 10, beforeCall: async () => {}, usedToday: async () => 0 };
const client = createEbayClient({
  clientId: EBAY_CLIENT_ID, clientSecret: EBAY_CLIENT_SECRET, fetchFn: fetch, now: () => new Date(),
  categoryIds: process.env.EBAY_CATEGORY_IDS ?? '183454', query: process.env.EBAY_QUERY ?? 'pokemon',
  minPrice: 25, budget,
});
const results = await client.searchNewGraded();
console.log(`search returned ${results.length} items`);
for (const s of results.slice(0, 5)) {
  const l = summaryToListing(s);
  if (!l) {
    console.log(`- skipped (non-USD or invalid price): ${s.title}`);
    continue;
  }
  console.log(`- $${l.price} + $${l.shipping ?? 'n/a'} | ${l.title}`);
}
const first = results[0];
if (first) {
  const item = await client.getItem(first.itemId);
  console.log('aspects:', JSON.stringify(item?.localizedAspects?.slice(0, 12), null, 2));
}
