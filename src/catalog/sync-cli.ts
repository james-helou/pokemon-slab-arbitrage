import { pgDb } from '../db/db.js';
import { log } from '../log.js';
import { syncCatalog } from './sync.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const db = pgDb(url);
const n = await syncCatalog(db, fetch, process.env.POKEMONTCG_API_KEY || undefined, log);
console.log(`synced ${n} cards`);
await db.end();
