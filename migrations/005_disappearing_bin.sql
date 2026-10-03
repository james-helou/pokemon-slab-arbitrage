-- Disappearing-BIN record (slice 2).
-- miss_count: consecutive newest-first scans whose window covered this listing's listed_at but did not return it.
alter table listings add column miss_count integer not null default 0;
-- Why gone_at was set:
--   out_of_stock = getItem returned the item with OUT_OF_STOCK availability (strongest "sold" signal);
--   not_found    = getItem 404: sold, ended by the seller, or relisted. The Browse API cannot tell these apart;
--   window_miss  = vanished from search and never confirmed. No comp is written, and a later sighting revives it.
alter table listings add column gone_reason text check (gone_reason in ('out_of_stock', 'not_found', 'window_miss'));
-- Last time a check confirmed the listing still live (stops re-checking it every few scans).
alter table listings add column checked_at timestamptz;
create index listings_suspect_idx on listings (miss_count) where gone_at is null and miss_count > 0;
create index listings_open_listed_idx on listings (listed_at) where gone_at is null;
create index listings_gone_idx on listings (gone_at) where gone_at is not null;
create index listing_matches_listing_idx on listing_matches (source, external_id, id desc);
