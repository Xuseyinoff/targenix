-- ──────────────────────────────────────────────────────────────────────────
-- Migration 0072 — rewrite legacy JSON config key
--                  `config.targetWebsiteId` → `config.destinationId`
-- on the `integrations` table.
--
-- Context: prior to migration 0071, the wizard wrote the destination ID
-- into integration.config JSON under `targetWebsiteId`. The dedicated
-- column rename in 0071 aligned the SQL identifier, but the JSON config
-- key (read by extractDestinationIdFromConfig as a fallback for rows
-- where the dedicated column is NULL) still used the legacy name.
--
-- This migration migrates ~176/188 production rows (per the local
-- audit on 2026-05-12) to the modern key shape:
--    { destinationId: <id>, ... }   instead of
--    { targetWebsiteId: <id>, ... }
--
-- Cost: row-by-row JSON_SET + JSON_REMOVE on a small table (<300 rows).
-- Sub-second wall clock; no metadata lock concerns.
--
-- Idempotency: guarded by WHERE — only rewrites rows where the legacy
-- key is present AND the modern key is absent. Re-running is a no-op.
--
-- Rollback: see 0072_rollback_rewrite_cfg_target_website_id.sql.
-- ──────────────────────────────────────────────────────────────────────────

UPDATE integrations
   SET config = JSON_REMOVE(
       JSON_SET(config, '$.destinationId', JSON_EXTRACT(config, '$.targetWebsiteId')),
       '$.targetWebsiteId'
     )
 WHERE JSON_EXTRACT(config, '$.targetWebsiteId') IS NOT NULL
   AND JSON_EXTRACT(config, '$.destinationId') IS NULL;
