create table vendor_credits (
  provider text not null,
  day date not null,
  credits int not null check (credits >= 0),
  primary key (provider, day)
);

create table vendor_card_cache (
  provider text not null,
  card_id text not null,
  fetched_at timestamptz not null,
  body jsonb null,
  primary key (provider, card_id)
);
