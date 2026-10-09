create table card_raw_prices (
  card_id text primary key references cards(id),
  raw_usd numeric null check (raw_usd is null or raw_usd > 0),
  source text not null,
  fetched_at timestamptz not null
);
