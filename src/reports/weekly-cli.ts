import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pgDb } from '../db/db.js';
import { loadSettings } from '../settings/settings.js';
import { previousIsoWeek } from './iso-week.js';
import { loadReportInput } from './report-data.js';
import { buildWeeklyReport } from './weekly.js';

// Usage: npm run report:weekly -- [--week 2026-W40] [--out vault/journal/weekly]
const { values } = parseArgs({ options: { week: { type: 'string' }, out: { type: 'string' } } });
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const db = pgDb(url);
try {
  const now = new Date();
  const week = values.week ?? previousIsoWeek(now);
  const outDir = values.out ?? 'vault/journal/weekly';
  const settings = await loadSettings(db);
  const report = buildWeeklyReport(await loadReportInput(db, week, now, settings.minNet));
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, `${week}.md`);
  await writeFile(path, report.markdown, 'utf8');
  console.log(`wrote ${path}`);
  console.log(report.summary);
} finally {
  await db.end();
}
