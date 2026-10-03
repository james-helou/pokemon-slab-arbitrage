import type { Db } from '../db/db.js';
import { claimJobRun, hasJobRun, recordJobRun, releaseJobRun } from '../jobs/job-runs.js';
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

export type WeeklyJobStatus = 'paused' | 'already_ran' | 'in_progress' | 'posted';

/**
 * Safe to call every hour: reports the last complete ISO week. A job_runs claim is taken before posting (so concurrent
 * ticks don't both post) and marked done after; a failed post releases this run's claim, so the next tick retries. A
 * claim abandoned by a crash is taken over after an hour. Delivery is at-least-once in crash windows: if the post
 * succeeds but recording it fails (or the process dies in between), the claim goes stale and the week is posted again.
 * Skipped while paused; catches up on resume.
 */
export async function runWeeklyReportJob(deps: WeeklyJobDeps): Promise<{ status: WeeklyJobStatus; week: string }> {
  const settings = await loadSettings(deps.db);
  const week = previousIsoWeek(deps.now());
  if (settings.paused) return { status: 'paused', week };
  if (await hasJobRun(deps.db, WEEKLY_REPORT_JOB, week)) return { status: 'already_ran', week };
  const claimedAt = await claimJobRun(deps.db, WEEKLY_REPORT_JOB, week, deps.now());
  if (!claimedAt) {
    return { status: (await hasJobRun(deps.db, WEEKLY_REPORT_JOB, week)) ? 'already_ran' : 'in_progress', week };
  }
  try {
    const report = buildWeeklyReport(await loadReportInput(deps.db, week, deps.now(), settings.minNet));
    await deps.post(report.summary, { name: `${week}.md`, body: report.markdown });
  } catch (err) {
    await releaseJobRun(deps.db, WEEKLY_REPORT_JOB, week, claimedAt);
    throw err;
  }
  await recordJobRun(deps.db, WEEKLY_REPORT_JOB, week, deps.now());
  return { status: 'posted', week };
}
