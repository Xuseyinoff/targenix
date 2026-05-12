-- ──────────────────────────────────────────────────────────────────────────
-- Migration 0075 — rename index names on the 6 tables renamed by 0074.
-- INSTANT DDL — no data movement. Pure SQL identifier cleanup.
--
-- ad_accounts:
--   uq_ad_accounts_cache_user_account     → uq_ad_accounts_user_account
--   idx_ad_accounts_cache_fb_account      → idx_ad_accounts_fb_account
-- campaigns:
--   uq_campaigns_cache_user_campaign      → uq_campaigns_user_campaign
--   idx_campaigns_cache_user_ad_account   → idx_campaigns_user_ad_account
-- ad_sets:
--   uq_ad_sets_cache_user_adset           → uq_ad_sets_user_adset
--   idx_ad_sets_cache_user_campaign       → idx_ad_sets_user_campaign
-- campaign_insights:
--   uq_campaign_insights_cache_key        → uq_campaign_insights_key
--   idx_campaign_insights_cache_account   → idx_campaign_insights_account
-- circuit_breakers:
--   uq_integration_health_dest            → uq_circuit_breakers_dest
--   idx_integration_health_state          → idx_circuit_breakers_state
--   idx_integration_health_appkey_state   → idx_circuit_breakers_appkey_state
-- circuit_breaker_events:
--   idx_ih_events_dest_time               → idx_cb_events_dest_time
--   idx_ih_events_type_time               → idx_cb_events_type_time
--
-- All guards check both src + dst — idempotent. Rollback: see
-- 0075_rollback_rename_legacy_index_names_v2.sql.
-- ──────────────────────────────────────────────────────────────────────────

-- Helper macro pattern: we generate one ALTER per index, each guarded.
-- (MySQL has no native conditional ALTER; we emulate with PREPARE.)

-- ad_accounts.uq_ad_accounts_cache_user_account
SET @s := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'ad_accounts'
    AND index_name = 'uq_ad_accounts_cache_user_account');
SET @d := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'ad_accounts'
    AND index_name = 'uq_ad_accounts_user_account');
SET @q := IF(@s >= 1 AND @d = 0,
  'ALTER TABLE ad_accounts RENAME INDEX uq_ad_accounts_cache_user_account TO uq_ad_accounts_user_account', 'DO 0');
PREPARE p FROM @q; EXECUTE p; DEALLOCATE PREPARE p;

-- ad_accounts.idx_ad_accounts_cache_fb_account
SET @s := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'ad_accounts'
    AND index_name = 'idx_ad_accounts_cache_fb_account');
SET @d := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'ad_accounts'
    AND index_name = 'idx_ad_accounts_fb_account');
SET @q := IF(@s >= 1 AND @d = 0,
  'ALTER TABLE ad_accounts RENAME INDEX idx_ad_accounts_cache_fb_account TO idx_ad_accounts_fb_account', 'DO 0');
PREPARE p FROM @q; EXECUTE p; DEALLOCATE PREPARE p;

-- campaigns.uq_campaigns_cache_user_campaign
SET @s := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'campaigns'
    AND index_name = 'uq_campaigns_cache_user_campaign');
SET @d := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'campaigns'
    AND index_name = 'uq_campaigns_user_campaign');
SET @q := IF(@s >= 1 AND @d = 0,
  'ALTER TABLE campaigns RENAME INDEX uq_campaigns_cache_user_campaign TO uq_campaigns_user_campaign', 'DO 0');
PREPARE p FROM @q; EXECUTE p; DEALLOCATE PREPARE p;

-- campaigns.idx_campaigns_cache_user_ad_account
SET @s := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'campaigns'
    AND index_name = 'idx_campaigns_cache_user_ad_account');
SET @d := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'campaigns'
    AND index_name = 'idx_campaigns_user_ad_account');
SET @q := IF(@s >= 1 AND @d = 0,
  'ALTER TABLE campaigns RENAME INDEX idx_campaigns_cache_user_ad_account TO idx_campaigns_user_ad_account', 'DO 0');
PREPARE p FROM @q; EXECUTE p; DEALLOCATE PREPARE p;

-- ad_sets.uq_ad_sets_cache_user_adset
SET @s := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'ad_sets'
    AND index_name = 'uq_ad_sets_cache_user_adset');
SET @d := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'ad_sets'
    AND index_name = 'uq_ad_sets_user_adset');
SET @q := IF(@s >= 1 AND @d = 0,
  'ALTER TABLE ad_sets RENAME INDEX uq_ad_sets_cache_user_adset TO uq_ad_sets_user_adset', 'DO 0');
PREPARE p FROM @q; EXECUTE p; DEALLOCATE PREPARE p;

-- ad_sets.idx_ad_sets_cache_user_campaign
SET @s := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'ad_sets'
    AND index_name = 'idx_ad_sets_cache_user_campaign');
SET @d := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'ad_sets'
    AND index_name = 'idx_ad_sets_user_campaign');
SET @q := IF(@s >= 1 AND @d = 0,
  'ALTER TABLE ad_sets RENAME INDEX idx_ad_sets_cache_user_campaign TO idx_ad_sets_user_campaign', 'DO 0');
PREPARE p FROM @q; EXECUTE p; DEALLOCATE PREPARE p;

-- campaign_insights.uq_campaign_insights_cache_key
SET @s := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'campaign_insights'
    AND index_name = 'uq_campaign_insights_cache_key');
SET @d := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'campaign_insights'
    AND index_name = 'uq_campaign_insights_key');
SET @q := IF(@s >= 1 AND @d = 0,
  'ALTER TABLE campaign_insights RENAME INDEX uq_campaign_insights_cache_key TO uq_campaign_insights_key', 'DO 0');
PREPARE p FROM @q; EXECUTE p; DEALLOCATE PREPARE p;

-- campaign_insights.idx_campaign_insights_cache_account
SET @s := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'campaign_insights'
    AND index_name = 'idx_campaign_insights_cache_account');
SET @d := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'campaign_insights'
    AND index_name = 'idx_campaign_insights_account');
SET @q := IF(@s >= 1 AND @d = 0,
  'ALTER TABLE campaign_insights RENAME INDEX idx_campaign_insights_cache_account TO idx_campaign_insights_account', 'DO 0');
PREPARE p FROM @q; EXECUTE p; DEALLOCATE PREPARE p;

-- circuit_breakers.uq_integration_health_dest
SET @s := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'circuit_breakers'
    AND index_name = 'uq_integration_health_dest');
SET @d := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'circuit_breakers'
    AND index_name = 'uq_circuit_breakers_dest');
SET @q := IF(@s >= 1 AND @d = 0,
  'ALTER TABLE circuit_breakers RENAME INDEX uq_integration_health_dest TO uq_circuit_breakers_dest', 'DO 0');
PREPARE p FROM @q; EXECUTE p; DEALLOCATE PREPARE p;

-- circuit_breakers.idx_integration_health_state
SET @s := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'circuit_breakers'
    AND index_name = 'idx_integration_health_state');
SET @d := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'circuit_breakers'
    AND index_name = 'idx_circuit_breakers_state');
SET @q := IF(@s >= 1 AND @d = 0,
  'ALTER TABLE circuit_breakers RENAME INDEX idx_integration_health_state TO idx_circuit_breakers_state', 'DO 0');
PREPARE p FROM @q; EXECUTE p; DEALLOCATE PREPARE p;

-- circuit_breakers.idx_integration_health_appkey_state
SET @s := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'circuit_breakers'
    AND index_name = 'idx_integration_health_appkey_state');
SET @d := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'circuit_breakers'
    AND index_name = 'idx_circuit_breakers_appkey_state');
SET @q := IF(@s >= 1 AND @d = 0,
  'ALTER TABLE circuit_breakers RENAME INDEX idx_integration_health_appkey_state TO idx_circuit_breakers_appkey_state', 'DO 0');
PREPARE p FROM @q; EXECUTE p; DEALLOCATE PREPARE p;

-- circuit_breaker_events.idx_ih_events_dest_time
SET @s := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'circuit_breaker_events'
    AND index_name = 'idx_ih_events_dest_time');
SET @d := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'circuit_breaker_events'
    AND index_name = 'idx_cb_events_dest_time');
SET @q := IF(@s >= 1 AND @d = 0,
  'ALTER TABLE circuit_breaker_events RENAME INDEX idx_ih_events_dest_time TO idx_cb_events_dest_time', 'DO 0');
PREPARE p FROM @q; EXECUTE p; DEALLOCATE PREPARE p;

-- circuit_breaker_events.idx_ih_events_type_time
SET @s := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'circuit_breaker_events'
    AND index_name = 'idx_ih_events_type_time');
SET @d := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'circuit_breaker_events'
    AND index_name = 'idx_cb_events_type_time');
SET @q := IF(@s >= 1 AND @d = 0,
  'ALTER TABLE circuit_breaker_events RENAME INDEX idx_ih_events_type_time TO idx_cb_events_type_time', 'DO 0');
PREPARE p FROM @q; EXECUTE p; DEALLOCATE PREPARE p;
