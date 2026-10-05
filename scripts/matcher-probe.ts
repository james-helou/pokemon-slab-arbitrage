/**
 * Live-catalog adversarial probe for the rules matcher (npm run matcher:probe).
 *
 * Syncs the REAL TCGdex English catalog (real fetch, ~200 requests) into an in-memory PGlite DB, runs the matcher over
 * every title in the live-title fixture, and prints per-outcome counts before (the fixture headings) vs after, every
 * title whose outcome changed, and every match at or above the alert floor with its card, set and number, for a human
 * to check line by line. Read-only: touches no real database and no .env.
 *
 * Usage: npm run matcher:probe [-- path/to/titles.txt]
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { findCandidates, findCandidatesInSet, getCard, listSets } from '../src/catalog/catalog-repo.js';
import { syncCatalog } from '../src/catalog/sync.js';
import type { Db } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { silentLog } from '../src/log.js';
import { matchListing, MATCHER_VERSION, type CandidateLookup, type SetLister } from '../src/matcher/matcher.js';

const FLOOR = 0.85;
const file = process.argv[2] ?? 'tests/fixtures/matcher/live-titles-2026-10-05.txt';

/** Fixture format: "== outcome (N)" headings, then titles indented by two spaces. */
function readFixture(path: string): { title: string; before: string }[] {
  const out: { title: string; before: string }[] = [];
  let before = 'unknown';
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const h = /^== (\S+) \(\d+\)/.exec(line);
    if (h) before = h[1]!;
    else if (line.startsWith('  ') && line.trim()) out.push({ title: line.slice(2), before });
  }
  return out;
}

const pg = new PGlite();
const db: Db = {
  async query<T>(text: string, params: unknown[] = []) {
    return { rows: (await pg.query<T>(text, params as never[])).rows };
  },
  async exec(text: string) {
    await pg.exec(text);
  },
};
await migrate(db, 'migrations');
const t0 = Date.now();
const sync = await syncCatalog(db, fetch, silentLog);
console.log(`catalog: ${sync.cards} cards synced in ${((Date.now() - t0) / 1000).toFixed(1)}s; skipped sets: ${sync.skippedSets.join(', ') || 'none'}`);
console.log(`matcher: ${MATCHER_VERSION}\n`);

const lookup: CandidateLookup = (n, t, set) => (set ? findCandidatesInSet(db, set, n) : findCandidates(db, n, t));
const sets: SetLister = () => listSets(db);

const rows = readFixture(file);
const before = new Map<string, number>();
const after = new Map<string, number>();
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const changed: string[] = [];
const high: string[] = [];

for (const { title, before: b } of rows) {
  const r = await matchListing({ title, aspects: {} }, lookup, sets);
  const outcome = r.match ? (r.match.confidence >= FLOOR ? 'matched' : 'matched_low') : r.reasons.join('+');
  bump(before, b);
  bump(after, outcome);
  if (outcome !== b) changed.push(`  ${b} -> ${outcome}${r.match ? ` (${r.match.cardId} ${r.match.confidence})` : ''}  |  ${title}`);
  if (r.match && r.match.confidence >= FLOOR) {
    const card = await getCard(db, r.match.cardId);
    high.push(
      `  ${r.match.confidence.toFixed(3)}  ${r.match.cardId}  "${card?.name}"  set="${card?.setName}"  #${card?.number}` +
        `  ${r.match.grader} ${r.match.grade}${r.reasons.length ? `  [${r.reasons.join(',')}]` : ''}\n      ${title}`,
    );
  }
}

const keys = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => (after.get(b) ?? 0) - (after.get(a) ?? 0));
console.log(`outcomes over ${rows.length} titles (before = fixture headings, after = this matcher; matched = >= ${FLOOR}):`);
for (const k of keys) console.log(`  ${k.padEnd(32)} ${String(before.get(k) ?? 0).padStart(4)} -> ${String(after.get(k) ?? 0).padStart(4)}`);
console.log(`\nchanged outcomes (${changed.length}):`);
console.log(changed.join('\n'));
console.log(`\nmatches >= ${FLOOR} (${high.length}) -- verify each card is the one the title names:`);
console.log(high.join('\n'));
await pg.close();
