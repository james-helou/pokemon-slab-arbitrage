-- Which scan found the listing. Set on insert, never updated. Existing rows all came from the US BIN scan.
alter table listings add column origin text not null default 'us_bin'
  check (origin in ('us_bin', 'ca_bin', 'auction'));
-- eBay buyingOptions (e.g. ["FIXED_PRICE","BEST_OFFER"]). Null = unknown.
alter table listings add column buying_options jsonb;
-- Seller's price before our CAD->USD conversion (CA scan only). price/shipping stay USD.
alter table listings add column original_price numeric(12,2);
alter table listings add column original_currency text;
-- Backfill from the stored eBay payload (summary or getItem body, both carry buyingOptions). Data only, no rows removed.
update listings set buying_options = raw->'buyingOptions'
  where buying_options is null and jsonb_typeof(raw->'buyingOptions') = 'array';
-- bin = buy at ask; offer = human sends suggested_price as a Best Offer; auction = human bids up to suggested_price.
alter table recommendations add column kind text not null default 'bin' check (kind in ('bin', 'offer', 'auction'));
alter table recommendations add column suggested_price numeric(12,2);
alter table recommendations add constraint recommendations_kind_price
  check ((kind = 'bin') = (suggested_price is null));
