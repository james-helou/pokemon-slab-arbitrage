create table cards (
  id text primary key,
  name text not null,
  number text not null,
  set_id text not null,
  set_name text not null,
  set_printed_total integer,
  language text not null default 'en',
  updated_at timestamptz not null default now()
);
create index cards_number_idx on cards (upper(number));

create table listings (
  source text not null,
  external_id text not null,
  title text not null,
  price numeric(12,2) not null,
  shipping numeric(12,2) not null default 0,
  currency text not null,
  url text not null,
  image_url text,
  seller_username text,
  seller_feedback_score integer,
  seller_feedback_pct numeric(5,2),
  listed_at timestamptz,
  aspects jsonb not null default '{}'::jsonb,
  raw jsonb not null,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  gone_at timestamptz,
  primary key (source, external_id)
);

create table listing_matches (
  id bigserial primary key,
  source text not null,
  external_id text not null,
  stage text not null check (stage in ('title', 'enriched')),
  card_id text references cards(id),
  grader text,
  grade numeric(3,1),
  grade_label text,
  cert text,
  confidence numeric(4,3),
  reasons jsonb not null,
  matcher_version text not null,
  created_at timestamptz not null default now(),
  foreign key (source, external_id) references listings (source, external_id)
);

create table comps (
  id bigserial primary key,
  card_id text not null references cards(id),
  grader text not null,
  grade numeric(3,1) not null,
  price numeric(12,2) not null,
  sold_at timestamptz not null,
  kind text not null check (kind in ('paid_source', 'disappearing_bin', 'browser_agent')),
  source_ref text not null,
  fetched_at timestamptz not null default now(),
  unique (kind, source_ref)
);
create index comps_key_idx on comps (card_id, grader, grade, sold_at desc);

create table valuations (
  id bigserial primary key,
  card_id text not null references cards(id),
  grader text not null,
  grade numeric(3,1) not null,
  value numeric(12,2) not null,
  low numeric(12,2) not null,
  high numeric(12,2) not null,
  comp_count integer not null,
  newest_comp_age_days numeric(8,2) not null,
  confidence numeric(4,3) not null,
  comps_source text not null,
  oracle_version text not null,
  computed_at timestamptz not null
);
create index valuations_key_idx on valuations (card_id, grader, grade, computed_at desc);

create table channels (
  name text primary key,
  enabled boolean not null,
  price_factor numeric(5,3) not null default 1,
  fee_pct numeric(6,4) not null,
  fee_tier_threshold numeric(12,2),
  fee_pct_above_tier numeric(6,4),
  fee_cap numeric(12,2),
  payment_pct numeric(6,4) not null default 0,
  payment_flat numeric(8,2) not null default 0,
  order_flat_fee numeric(8,2) not null default 0,
  outbound_shipping numeric(8,2) not null default 0,
  supplies numeric(8,2) not null default 0,
  avg_days_to_sell numeric(6,1)
);
insert into channels (name, enabled, price_factor, fee_pct, fee_tier_threshold, fee_pct_above_tier, fee_cap,
  payment_pct, payment_flat, order_flat_fee, outbound_shipping, supplies, avg_days_to_sell) values
  ('ebay',      true,  1.000, 0.1325, 7500, 0.0235, null, 0,     0,    0.40, 5.00, 1.50, 10),
  ('tcgplayer', true,  0.950, 0.1075, null, null,   75,   0.025, 0.30, 0,    5.00, 1.50, 21),
  ('friend',    false, 1.000, 0,      null, null,   null, 0,     0,    0,    0,    0,    null),
  ('local',     false, 0.900, 0,      null, null,   null, 0,     0,    0,    0,    0,    30);

create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create function forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end;
$$;

create table recommendations (
  id bigserial primary key,
  source text not null,
  external_id text not null,
  card_id text not null references cards(id),
  grader text not null,
  grade numeric(3,1) not null,
  cert text,
  listing_snapshot jsonb not null,
  card_snapshot jsonb not null,
  valuation_snapshot jsonb not null,
  channel_nets jsonb not null,
  best_channel text not null,
  buy_total numeric(12,2) not null,
  best_net numeric(12,2) not null,
  roi numeric(8,4) not null,
  confidence numeric(4,3) not null,
  rank numeric(12,2) not null,
  red_flags jsonb not null,
  routed_to text not null check (routed_to in ('alerts', 'over_budget')),
  scorer_version text not null,
  matcher_version text not null,
  oracle_version text not null,
  created_at timestamptz not null default now(),
  unique (source, external_id)
);
create trigger recommendations_append_only before update or delete on recommendations
  for each row execute function forbid_mutation();

create table decisions (
  id bigserial primary key,
  recommendation_id bigint not null references recommendations(id),
  action text not null check (action in ('bought', 'pass', 'watch')),
  reason text,
  actor text,
  created_at timestamptz not null default now()
);
create trigger decisions_append_only before update or delete on decisions
  for each row execute function forbid_mutation();

create table alert_deliveries (
  recommendation_id bigint primary key references recommendations(id),
  route text not null check (route in ('alerts', 'over_budget')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 0,
  message_id text,
  last_error text,
  updated_at timestamptz not null default now()
);

create table bankroll_ledger (
  id bigserial primary key,
  kind text not null check (kind in ('deposit', 'withdrawal', 'purchase', 'sale', 'fee', 'adjustment')),
  amount numeric(12,2) not null,
  recommendation_id bigint references recommendations(id),
  note text,
  created_at timestamptz not null default now()
);
create trigger bankroll_ledger_append_only before update or delete on bankroll_ledger
  for each row execute function forbid_mutation();

create table api_usage (
  day date not null,
  source text not null,
  calls integer not null default 0,
  primary key (day, source)
);
