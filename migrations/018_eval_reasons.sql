-- Latest evaluation verdict per listing, so "why didn't this alert?" is a query, not a guess.
-- Overwritten on each evaluation (auctions are re-evaluated). Null = evaluated before this migration, or never.
alter table listings add column eval_status text;
alter table listings add column eval_reasons jsonb;
-- Numbers behind a score rejection (price, shipping, buyTotal, value, bestNet, roi, ...). Null when not scored.
alter table listings add column eval_detail jsonb;
