-- ──────────────────────────────────────────────────────────────────────────
-- Rollback for 0072 — restore the legacy `config.targetWebsiteId` key.
-- Symmetric: only touches rows where the modern key is set and the legacy
-- key is missing.
-- ──────────────────────────────────────────────────────────────────────────

UPDATE integrations
   SET config = JSON_REMOVE(
       JSON_SET(config, '$.targetWebsiteId', JSON_EXTRACT(config, '$.destinationId')),
       '$.destinationId'
     )
 WHERE JSON_EXTRACT(config, '$.destinationId') IS NOT NULL
   AND JSON_EXTRACT(config, '$.targetWebsiteId') IS NULL;
