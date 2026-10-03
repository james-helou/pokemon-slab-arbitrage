-- Once-per-period jobs (weekly report). A row means the job completed for that period.
create table job_runs (
  job text not null,
  period text not null,
  ran_at timestamptz not null,
  primary key (job, period)
);
