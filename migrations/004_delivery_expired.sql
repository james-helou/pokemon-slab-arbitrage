-- Deliveries older than settings.maxAlertAgeMinutes are never sent; they are marked 'expired'.
alter table alert_deliveries drop constraint alert_deliveries_status_check;
alter table alert_deliveries add constraint alert_deliveries_status_check
  check (status in ('pending', 'sent', 'failed', 'expired'));
