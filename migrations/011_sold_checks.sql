-- Sold check (plan 2026-10-04-sold-check): one immutable row per eBay sold-listings fetch for an alert candidate.
-- Scraped results live only here, never in comps, and never feed the oracle.
create table sold_checks (
  id bigserial primary key,
  card_id text not null,
  grader text not null,
  grade numeric(3,1) not null,
  query text not null,
  status text not null check (status in ('ok', 'no_results', 'blocked', 'error')),
  fetched_at timestamptz not null,
  sale_count integer not null default 0,
  median numeric(12,2),
  low numeric(12,2),
  high numeric(12,2),
  newest_sold_at timestamptz,
  matched_titles jsonb not null default '[]'::jsonb
    check (jsonb_typeof(matched_titles) = 'array' and jsonb_array_length(matched_titles) <= 30),
  parser_version text not null,
  created_at timestamptz not null default now()
);
create index sold_checks_key_idx on sold_checks (card_id, grader, grade, fetched_at desc);
create index sold_checks_fetched_idx on sold_checks (fetched_at);
create trigger sold_checks_append_only before update or delete on sold_checks
  for each row execute function forbid_mutation();

-- Nullable summary snapshot written with the recommendation when the check ran.
alter table recommendations add column if not exists sold_check jsonb;
