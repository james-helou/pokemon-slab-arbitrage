import type { Db } from '../db/db.js';
import { hasJobRun, recordJobRun } from '../jobs/job-runs.js';
import type { Log } from '../log.js';
import { loadSettings } from '../settings/settings.js';
import { previousIsoWeek } from './iso-week.js';
import { loadReportInput } from './report-data.js';
import { buildWeeklyReport } from './weekly.js';

export const WEEKLY_REPORT_JOB = 'weekly_report';

export interface WeeklyJobDeps {
  db: Db;
  now: () => Date;
  log: Log;
  /** Posts the short summary plus the full markdown as an attachment (the container cannot write the vault). */
  post: (summary: string, file: { name: string; body: string }) => Promise<void>;
}

export type WeeklyJobStatus = 'paused' | 'already_ran' | 'posted';

/**
 * Safe to call every hour: reports the last complete ISO week once. The job_runs row is written only after a
 * successful post, so a Discord failure retries on the next tick. Skipped while paused; catches up on resume.
 */
export async function runWeeklyReportJob(deps: WeeklyJobDeps): Promise<{ status: WeeklyJobStatus; week: string }> {
  const settings = await loadSettings(deps.db);
  const week = previousIsoWeek(deps.now());
  if (settings.paused) return { status: 'paused', week };
  if (await hasJobRun(deps.db, WEEKLY_REPORT_JOB, week)) return { status: 'already_ran', week };
  const report = buildWeeklyReport(await loadReportInput(deps.db, week, deps.now(), settings.minNet));
  await deps.post(report.summary, { name: `${week}.md`, body: report.markdown });
  await recordJobRun(deps.db, WEEKLY_REPORT_JOB, week, deps.now());
  return { status: 'posted', week };
}
