import { describe, expect, it } from 'vitest';
import { hasJobRun, recordJobRun } from '../../src/jobs/job-runs.js';
import { silentLog } from '../../src/log.js';
import { runWeeklyReportJob, type WeeklyJobDeps } from '../../src/reports/weekly-job.js';
import { setSetting } from '../../src/settings/settings.js';
import { createTestDb } from '../helpers/test-db.js';

const NOW = () => new Date('2026-10-05T01:00:00Z');
type Post = { summary: string; file: { name: string; body: string } };

async function setup(fail = () => false) {
  const db = await createTestDb();
  const posts: Post[] = [];
  const deps: WeeklyJobDeps = {
    db, now: NOW, log: silentLog,
    post: async (summary, file) => {
      if (fail()) throw new Error('discord down');
      posts.push({ summary, file });
    },
  };
  return { db, deps, posts };
}

describe('job runs', () => {
  it('records a period once', async () => {
    const { db } = await setup();
    expect(await hasJobRun(db, 'x', '2026-W40')).toBe(false);
    await recordJobRun(db, 'x', '2026-W40', NOW());
    await recordJobRun(db, 'x', '2026-W40', NOW());
    expect(await hasJobRun(db, 'x', '2026-W40')).toBe(true);
  });
});

describe('runWeeklyReportJob', () => {
  it('posts the previous ISO week exactly once', async () => {
    const { deps, posts } = await setup();
    expect(await runWeeklyReportJob(deps)).toEqual({ status: 'posted', week: '2026-W40' });
    expect(await runWeeklyReportJob(deps)).toEqual({ status: 'already_ran', week: '2026-W40' });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.file.name).toBe('2026-W40.md');
    expect(posts[0]!.file.body).toContain('# Weekly calibration 2026-W40');
    expect(posts[0]!.summary).toContain('Weekly calibration 2026-W40');
  });

  it('retries on the next tick when posting fails', async () => {
    let failing = true;
    const { deps, posts } = await setup(() => failing);
    await expect(runWeeklyReportJob(deps)).rejects.toThrow('discord down');
    failing = false;
    expect((await runWeeklyReportJob(deps)).status).toBe('posted');
    expect(posts).toHaveLength(1);
  });

  it('posts once when two ticks race', async () => {
    const { deps, posts } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow: WeeklyJobDeps = { ...deps, post: async (s, f) => { await gate; await deps.post(s, f); } };
    const both = Promise.all([runWeeklyReportJob(slow), runWeeklyReportJob(slow)]);
    setTimeout(release, 50);
    const statuses = (await both).map((r) => r.status).sort();
    expect(statuses).toEqual(['in_progress', 'posted']);
    expect(posts).toHaveLength(1);
    expect((await runWeeklyReportJob(deps)).status).toBe('already_ran');
  });

  it('a claim is not a completed run; a stale claim (over 1 hour) is re-claimed', async () => {
    const { db, deps, posts } = await setup();
    await db.query(
      `insert into job_runs (job, period, ran_at, status, claimed_at) values ('weekly_report', '2026-W40', $1, 'claimed', $1)`,
      [new Date(NOW().getTime() - 30 * 60_000)],
    );
    expect(await hasJobRun(db, 'weekly_report', '2026-W40')).toBe(false);
    expect((await runWeeklyReportJob(deps)).status).toBe('in_progress');
    expect(posts).toHaveLength(0);
    await db.query(`update job_runs set claimed_at = $1`, [new Date(NOW().getTime() - 61 * 60_000)]);
    expect((await runWeeklyReportJob(deps)).status).toBe('posted');
    expect(posts).toHaveLength(1);
    const { rows } = await db.query<{ status: string }>('select status from job_runs');
    expect(rows).toEqual([{ status: 'done' }]);
  });

  it('skips while paused and catches up after resume', async () => {
    const { db, deps, posts } = await setup();
    await setSetting(db, 'paused', true);
    expect((await runWeeklyReportJob(deps)).status).toBe('paused');
    await setSetting(db, 'paused', false);
    expect((await runWeeklyReportJob(deps)).status).toBe('posted');
    expect(posts).toHaveLength(1);
  });
});
