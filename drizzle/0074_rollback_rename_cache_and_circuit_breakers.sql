-- ──────────────────────────────────────────────────────────────────────────
-- Rollback for 0074 — restore the 6 legacy table names. Symmetric guards.
-- ──────────────────────────────────────────────────────────────────────────

-- 1. ad_accounts → ad_accounts_cache
DROP VIEW IF EXISTS ad_accounts_cache;
SET @src_exists := (SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'ad_accounts');
SET @dst_exists := (SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'ad_accounts_cache');
SET @stmt := IF(@src_exists = 1 AND @dst_exists = 0,
  'RENAME TABLE ad_accounts TO ad_accounts_cache', 'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;
CREATE OR REPLACE VIEW ad_accounts AS SELECT * FROM ad_accounts_cache;

-- 2. campaigns → campaigns_cache
DROP VIEW IF EXISTS campaigns_cache;
SET @src_exists := (SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'campaigns');
SET @dst_exists := (SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'campaigns_cache');
SET @stmt := IF(@src_exists = 1 AND @dst_exists = 0,
  'RENAME TABLE campaigns TO campaigns_cache', 'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;
CREATE OR REPLACE VIEW campaigns AS SELECT * FROM campaigns_cache;

-- 3. ad_sets → ad_sets_cache
DROP VIEW IF EXISTS ad_sets_cache;
SET @src_exists := (SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'ad_sets');
SET @dst_exists := (SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'ad_sets_cache');
SET @stmt := IF(@src_exists = 1 AND @dst_exists = 0,
  'RENAME TABLE ad_sets TO ad_sets_cache', 'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;
CREATE OR REPLACE VIEW ad_sets AS SELECT * FROM ad_sets_cache;

-- 4. campaign_insights → campaign_insights_cache
DROP VIEW IF EXISTS campaign_insights_cache;
SET @src_exists := (SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'campaign_insights');
SET @dst_exists := (SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'campaign_insights_cache');
SET @stmt := IF(@src_exists = 1 AND @dst_exists = 0,
  'RENAME TABLE campaign_insights TO campaign_insights_cache', 'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;
CREATE OR REPLACE VIEW campaign_insights AS SELECT * FROM campaign_insights_cache;

-- 5. circuit_breakers → integration_health
DROP VIEW IF EXISTS integration_health;
SET @src_exists := (SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'circuit_breakers');
SET @dst_exists := (SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'integration_health');
SET @stmt := IF(@src_exists = 1 AND @dst_exists = 0,
  'RENAME TABLE circuit_breakers TO integration_health', 'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;
CREATE OR REPLACE VIEW circuit_breakers AS SELECT * FROM integration_health;

-- 6. circuit_breaker_events → integration_health_events
DROP VIEW IF EXISTS integration_health_events;
SET @src_exists := (SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'circuit_breaker_events');
SET @dst_exists := (SELECT COUNT(*) FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'integration_health_events');
SET @stmt := IF(@src_exists = 1 AND @dst_exists = 0,
  'RENAME TABLE circuit_breaker_events TO integration_health_events', 'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;
CREATE OR REPLACE VIEW circuit_breaker_events AS SELECT * FROM integration_health_events;
