-- ──────────────────────────────────────────────────────────────────────────
-- Migration 0074 — rename "_cache" suffix tables and circuit-breaker tables
-- to professional SaaS-style names. View-backed back-compat (same pattern
-- as 0069) keeps any in-flight legacy code working until 0076 drops the
-- views.
--
-- Renames:
--   ad_accounts_cache         → ad_accounts          (system-of-record for UI)
--   campaigns_cache           → campaigns
--   ad_sets_cache             → ad_sets
--   campaign_insights_cache   → campaign_insights
--   integration_health        → circuit_breakers     (matches the actual pattern)
--   integration_health_events → circuit_breaker_events
--
-- Cost: RENAME TABLE on InnoDB is metadata-only (<100 ms each on our
-- table sizes). VIEW creation is instant. Total wall-clock: <1 s.
--
-- Idempotency: each rename + view block is guarded — re-running on a
-- partially-applied DB is safe.
--
-- Rollback: see 0074_rollback_rename_cache_and_circuit_breakers.sql.
-- ──────────────────────────────────────────────────────────────────────────

-- 1. ad_accounts_cache → ad_accounts
DROP VIEW IF EXISTS ad_accounts;
SET @src_exists := (SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'ad_accounts_cache');
SET @dst_exists := (SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'ad_accounts');
SET @stmt := IF(@src_exists = 1 AND @dst_exists = 0,
  'RENAME TABLE ad_accounts_cache TO ad_accounts', 'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;
CREATE OR REPLACE VIEW ad_accounts_cache AS SELECT * FROM ad_accounts;


-- 2. campaigns_cache → campaigns
DROP VIEW IF EXISTS campaigns;
SET @src_exists := (SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'campaigns_cache');
SET @dst_exists := (SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'campaigns');
SET @stmt := IF(@src_exists = 1 AND @dst_exists = 0,
  'RENAME TABLE campaigns_cache TO campaigns', 'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;
CREATE OR REPLACE VIEW campaigns_cache AS SELECT * FROM campaigns;


-- 3. ad_sets_cache → ad_sets
DROP VIEW IF EXISTS ad_sets;
SET @src_exists := (SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'ad_sets_cache');
SET @dst_exists := (SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'ad_sets');
SET @stmt := IF(@src_exists = 1 AND @dst_exists = 0,
  'RENAME TABLE ad_sets_cache TO ad_sets', 'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;
CREATE OR REPLACE VIEW ad_sets_cache AS SELECT * FROM ad_sets;


-- 4. campaign_insights_cache → campaign_insights
DROP VIEW IF EXISTS campaign_insights;
SET @src_exists := (SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'campaign_insights_cache');
SET @dst_exists := (SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'campaign_insights');
SET @stmt := IF(@src_exists = 1 AND @dst_exists = 0,
  'RENAME TABLE campaign_insights_cache TO campaign_insights', 'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;
CREATE OR REPLACE VIEW campaign_insights_cache AS SELECT * FROM campaign_insights;


-- 5. integration_health → circuit_breakers
DROP VIEW IF EXISTS circuit_breakers;
SET @src_exists := (SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'integration_health');
SET @dst_exists := (SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'circuit_breakers');
SET @stmt := IF(@src_exists = 1 AND @dst_exists = 0,
  'RENAME TABLE integration_health TO circuit_breakers', 'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;
CREATE OR REPLACE VIEW integration_health AS SELECT * FROM circuit_breakers;


-- 6. integration_health_events → circuit_breaker_events
DROP VIEW IF EXISTS circuit_breaker_events;
SET @src_exists := (SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'integration_health_events');
SET @dst_exists := (SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'circuit_breaker_events');
SET @stmt := IF(@src_exists = 1 AND @dst_exists = 0,
  'RENAME TABLE integration_health_events TO circuit_breaker_events', 'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;
CREATE OR REPLACE VIEW integration_health_events AS SELECT * FROM circuit_breaker_events;
