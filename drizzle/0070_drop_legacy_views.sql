-- ──────────────────────────────────────────────────────────────────────────
-- Migration 0070 — drop the backward-compat VIEWs created by 0069.
--
-- Context: 0069 renamed `target_websites` → `destinations` and
-- `integration_destinations` → `integration_routes`, then created VIEWs at
-- the old names so legacy callers kept working during the transition.
-- Every active runtime caller (server, client, tests) has since been
-- migrated to the new names. The only remaining users of the legacy names
-- are historical one-off `tooling/*` scripts (already-completed migrations,
-- archive scripts) — these are intentionally allowed to break, since
-- re-running them is not supported anyway.
--
-- Idempotency: `DROP VIEW IF EXISTS` is a no-op when the view is absent.
--
-- Rollback: see 0070_rollback_drop_legacy_views.sql.
-- ──────────────────────────────────────────────────────────────────────────

DROP VIEW IF EXISTS target_websites;
DROP VIEW IF EXISTS integration_destinations;
