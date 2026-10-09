/**
 * One-call PokemonPriceTracker probe (npm run ppt:probe -- <tcgdexCardId>), e.g. sv03.5-199.
 *
 * Reads PPT_API_KEY from the environment, resolves the card's TCGplayer id from TCGdex, makes ONE PPT call (costs 2 of
 * the 100 daily free credits; the DB budget is NOT consulted or updated, so count it yourself), prints the JSON body
 * and what the parser extracts per PSA grade. Never prints the key or request headers. Writes nothing to any DB.
 */
import { parsePptCard, PPT_PARSER_VERSION } from '../src/ppt/aggregate-source.js';
import { createPptClient } from '../src/ppt/client.js';
import { tcgplayerIds } from '../src/poketrace/mapping.js';

const cardId = process.argv[2];
const apiKey = process.env['PPT_API_KEY'];
if (!cardId) {
  console.error('usage: npm run ppt:probe -- <tcgdexCardId>');
  process.exit(2);
}
if (!apiKey) {
  console.error('PPT_API_KEY is not set in the environment');
  process.exit(2);
}

const ids = await tcgplayerIds(fetch, cardId);
console.log(`tcgdex ${cardId}: tcgplayer ids = ${JSON.stringify(ids)}`);
if (ids.length !== 1) {
  console.log('need exactly one tcgplayer id; no PPT call made');
  process.exit(0);
}

const client = createPptClient({ apiKey, fetch });
let body: unknown;
try {
  body = await client.get('/cards', { tcgPlayerId: ids[0]!, includeEbay: 'true', days: '30' });
} catch (err) {
  // The client's errors carry the path and status only.
  console.error(err instanceof Error ? err.message : 'request failed');
  process.exit(1);
}
console.log(JSON.stringify(body, null, 2));

console.log(`\nparser ${PPT_PARSER_VERSION}:`);
const now = new Date();
for (const grade of [10, 9.5, 9, 8.5, 8, 7, 6, 5]) {
  const p = parsePptCard(body, { grader: 'PSA', grade }, now);
  console.log(`PSA ${grade}: ${p ? JSON.stringify(p) : 'null'}`);
}
