import type { Db } from '../db/db.js';

/** A claim older than this is presumed abandoned (crashed mid-run) and may be taken over. */
export const STALE_CLAIM_MS = 3_600_000;

/** True once the job completed for the period (a live claim does not count). */
export async function hasJobRun(db: Db, job: string, period: string): Promise<boolean> {
  const { rows } = await db.query(`select 1 from job_runs where job = $1 and period = $2 and status = 'done'`, [job, period]);
  return rows.length > 0;
}

/**
 * Atomically claims (job, period) before its side effect. Returns the claim's claimed_at (pass it to releaseJobRun),
 * or null when the period is done or another run holds a claim younger than STALE_CLAIM_MS.
 */
export async function claimJobRun(db: Db, job: string, period: string, at: Date): Promise<Date | null> {
  const { rows } = await db.query<{ claimed_at: Date | string }>(
    `insert into job_runs (job, period, ran_at, status, claimed_at) values ($1, $2, $3, 'claimed', $3)
     on conflict (job, period) do update set ran_at = excluded.ran_at, claimed_at = excluded.claimed_at
       where job_runs.status = 'claimed' and job_runs.claimed_at < $4
     returning claimed_at`,
    [job, period, at, new Date(at.getTime() - STALE_CLAIM_MS)],
  );
  const row = rows[0];
  return row ? new Date(row.claimed_at) : null;
}

/**
 * Drops our claim after a failed side effect so the next tick retries straight away. Scoped to the claim this run
 * made (claimedAt from claimJobRun), so a stale claim since taken over by another run is left alone.
 */
export async function releaseJobRun(db: Db, job: string, period: string, claimedAt: Date): Promise<void> {
  await db.query(
    `delete from job_runs where job = $1 and period = $2 and status = 'claimed' and claimed_at = $3`,
    [job, period, claimedAt],
  );
}

/** Marks a job complete for a period. Call only after the job's side effect succeeded. */
export async function recordJobRun(db: Db, job: string, period: string, at: Date): Promise<void> {
  await db.query(
    `insert into job_runs (job, period, ran_at, status) values ($1, $2, $3, 'done')
     on conflict (job, period) do update set status = 'done', ran_at = excluded.ran_at`,
    [job, period, at],
  );
}
