-- At most one 'bought' decision per recommendation (prevents double-buy races).
create unique index decisions_one_bought on decisions (recommendation_id) where action = 'bought';

-- Unknown shipping is stored as NULL (not 0).
alter table listings alter column shipping drop not null;
alter table listings alter column shipping drop default;

-- Delivery claiming: a row is due when next_attempt_at is null or in the past.
alter table alert_deliveries add column next_attempt_at timestamptz;
