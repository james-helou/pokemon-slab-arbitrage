-- Claim-before-post for once-per-period jobs: a 'claimed' row blocks concurrent ticks; 'done' means completed.
-- Existing rows were written only after success, so they default to 'done'.
alter table job_runs add column if not exists status text not null default 'done';
alter table job_runs add column if not exists claimed_at timestamptz;
alter table job_runs add constraint job_runs_status_check check (status in ('claimed', 'done'));
