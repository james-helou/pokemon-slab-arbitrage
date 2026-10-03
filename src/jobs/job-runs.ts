import type { Db } from '../db/db.js';

/** A claim older than this is presumed abandoned (crashed mid-run) and may be taken over. */
export const STALE_CLAIM_MS = 3_600_000;

/** True once the job completed for the period (a live claim does not count). */
export async function hasJobRun(db: Db, job: string, period: string): Promise<boolean> {
  const { rows } = await db.query(`select 1 from job_runs where job = $1 and period = $2 and status = 'done'`, [job, period]);
  return rows.length > 0;
}

/**
 * Atomically claims (job, period) before its side effect. Returns false when the period is done or another run holds
 * a claim younger than STALE_CLAIM_MS.
 */
export async function claimJobRun(db: Db, job: string, period: string, at: Date): Promise<boolean> {
  const { rows } = await db.query(
    `insert into job_runs (job, period, ran_at, status, claimed_at) values ($1, $2, $3, 'claimed', $3)
     on conflict (job, period) do update set ran_at = excluded.ran_at, claimed_at = excluded.claimed_at
       where job_runs.status = 'claimed' and job_runs.claimed_at < $4
     returning 1`,
    [job, period, at, new Date(at.getTime() - STALE_CLAIM_MS)],
  );
  return rows.length > 0;
}

/** Drops our claim after a failed side effect so the next tick retries straight away. */
export async function releaseJobRun(db: Db, job: string, period: string): Promise<void> {
  await db.query(`delete from job_runs where job = $1 and period = $2 and status = 'claimed'`, [job, period]);
}

/** Marks a job complete for a period. Call only after the job's side effect succeeded. */
export async function recordJobRun(db: Db, job: string, period: string, at: Date): Promise<void> {
  await db.query(
    `insert into job_runs (job, period, ran_at, status) values ($1, $2, $3, 'done')
     on conflict (job, period) do update set status = 'done', ran_at = excluded.ran_at`,
    [job, period, at],
  );
}
