import { pgDb } from './db.js';
import { migrate } from './migrate.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const db = pgDb(url);
const applied = await migrate(db, 'migrations');
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
await db.end();
