-- ──────────────────────────────────────────────────────────────────────────
-- Migration 0076 — drop the 6 back-compat VIEWs created by 0074.
--
-- The application has been deployed and verified using the new table
-- names. No active code path reads from the legacy names. Drop the views
-- to remove the last trace of legacy naming.
--
-- Idempotent. Rollback re-creates them.
-- ──────────────────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS ad_accounts_cache;
DROP VIEW IF EXISTS campaigns_cache;
DROP VIEW IF EXISTS ad_sets_cache;
DROP VIEW IF EXISTS campaign_insights_cache;
DROP VIEW IF EXISTS integration_health;
DROP VIEW IF EXISTS integration_health_events;
