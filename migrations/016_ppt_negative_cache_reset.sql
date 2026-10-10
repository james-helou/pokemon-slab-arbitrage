-- One-off reset of PPT negative cache entries written by the old id rule (Base Set style cards were refused as
-- ambiguous). Cache data only, no schema change; 'failed' markers are transient and left alone.
delete from vendor_card_cache where provider = 'ppt' and body is null and (kind is null or kind <> 'failed');
