import type { Db } from '../db/db.js';

export async function hasJobRun(db: Db, job: string, period: string): Promise<boolean> {
  const { rows } = await db.query('select 1 from job_runs where job = $1 and period = $2', [job, period]);
  return rows.length > 0;
}

/** Marks a job complete for a period. Call only after the job's side effect succeeded. */
export async function recordJobRun(db: Db, job: string, period: string, at: Date): Promise<void> {
  await db.query(
    `insert into job_runs (job, period, ran_at) values ($1, $2, $3) on conflict (job, period) do nothing`,
    [job, period, at],
  );
}
