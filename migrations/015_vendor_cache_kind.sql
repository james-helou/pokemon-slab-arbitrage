-- null = normal entry (positive when body is set, negative when null); 'failed' = short-lived transient-failure marker.
alter table vendor_card_cache add column kind text null;
