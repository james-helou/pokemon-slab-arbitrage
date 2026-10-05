-- Sold check hardening: row-level sanity checks on sold_checks (additive; 011 is never edited).
-- The runner already writes rows that satisfy these; they stop a future bug from storing nonsense stats.
alter table sold_checks
  add constraint sold_checks_sale_count_nonneg check (sale_count >= 0),
  add constraint sold_checks_median_pos check (median is null or median > 0),
  add constraint sold_checks_low_pos check (low is null or low > 0),
  add constraint sold_checks_high_pos check (high is null or high > 0),
  add constraint sold_checks_stats_ordered check (
    low is null or median is null or high is null or (low <= median and median <= high)
  ),
  -- Mirrors the Grader type in src/domain/types.ts.
  add constraint sold_checks_grader_known check (grader in ('PSA', 'CGC', 'BGS', 'SGC', 'TAG')),
  add constraint sold_checks_stats_only_when_ok check (
    status = 'ok' or (median is null and low is null and high is null)
  );
