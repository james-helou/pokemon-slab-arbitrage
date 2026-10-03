import { pgDb } from '../db/db.js';
import { log } from '../log.js';
import { syncCatalog } from './sync.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const db = pgDb(url);
const r = await syncCatalog(db, fetch, log);
console.log(`synced ${r.cards} cards; skipped sets: ${r.skippedSets.join(', ') || 'none'}`);
await db.end();
