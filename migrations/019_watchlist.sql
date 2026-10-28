-- Auction watchlist (2026-10-28 pivot): live auctions bid above market value. One row per watched eBay auction.
create table watch_auctions (
  source text not null,
  external_id text not null,
  card_id text references cards(id),
  grader text,
  grade numeric(3,1),
  title text not null,
  url text not null,
  image_url text,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  ends_at timestamptz not null,
  current_bid numeric(12,2) not null,
  bid_count int not null,
  -- null = not matched yet; 'ok' = matched to card_id/grader/grade; otherwise the reason it never will be.
  match_status text,
  value_at_alert numeric(12,2),
  sources_at_alert jsonb,
  alerted_at timestamptz,
  alerted_bid numeric(12,2),
  realerted_at timestamptz,
  realerted_bid numeric(12,2),
  final_bid numeric(12,2),
  final_bid_count int,
  ended_at timestamptz,
  primary key (source, external_id)
);
create index watch_auctions_open_idx on watch_auctions (ends_at) where ended_at is null;
-- Widen comps.kind (no row changes): our own watched auction results become comps.
-- comps_kind_check is the name Postgres gave the inline check in 001_init.sql.
alter table comps drop constraint comps_kind_check;
alter table comps add constraint comps_kind_check
  check (kind in ('paid_source', 'disappearing_bin', 'browser_agent', 'auction_result'));
