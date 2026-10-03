-- Outcome tracker (spec §3 module 11, §4, §5). One immutable row per recommendation and horizon.
create table outcomes (
  id bigserial primary key,
  recommendation_id bigint not null references recommendations(id),
  horizon_days integer not null check (horizon_days in (7, 14, 30)),
  listing_final_state text not null check (listing_final_state in ('live', 'sold_out', 'not_found', 'gone_unknown')),
  observed_price numeric(12,2),
  market_value_at_horizon numeric(12,2),
  valuation_confidence numeric(4,3),
  valuation_comp_count integer,
  net_at_horizon numeric(12,2),
  net_channel text,
  label text check (label in ('good', 'marginal', 'bad')),
  label_basis text not null check (label_basis in ('counterfactual', 'realized', 'no_valuation')),
  decision text not null check (decision in ('bought', 'pass', 'watch', 'none')),
  min_net numeric(12,2) not null,
  tracker_version text not null,
  oracle_version text,
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (recommendation_id, horizon_days)
);
create index outcomes_observed_idx on outcomes (observed_at);
create trigger outcomes_append_only before update or delete on outcomes
  for each row execute function forbid_mutation();
