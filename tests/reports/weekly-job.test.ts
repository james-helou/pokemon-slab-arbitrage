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

  it('skips while paused and catches up after resume', async () => {
    const { db, deps, posts } = await setup();
    await setSetting(db, 'paused', true);
    expect((await runWeeklyReportJob(deps)).status).toBe('paused');
    await setSetting(db, 'paused', false);
    expect((await runWeeklyReportJob(deps)).status).toBe('posted');
    expect(posts).toHaveLength(1);
  });
});
