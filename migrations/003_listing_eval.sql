-- Evaluation bookkeeping so transient failures are retried (bounded) instead of lost.
alter table listings add column evaluated_at timestamptz;
alter table listings add column eval_attempts int not null default 0;
