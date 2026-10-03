-- Maps our TCGdex card ids to vendor ids (e.g. PokeTrace uuids), resolved on demand.
-- external_id null = negative cache (no confident match); callers expire it by resolved_at.
create table card_external_ids (
  card_id text not null references cards(id),
  provider text not null,
  external_id text,
  resolved_at timestamptz not null,
  primary key (card_id, provider)
);
