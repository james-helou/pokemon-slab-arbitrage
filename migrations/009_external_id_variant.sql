-- PokeTrace variant of the mapped card (e.g. Holofoil, Unlimited), for audit of which printing we price against.
alter table card_external_ids add column if not exists variant text;
