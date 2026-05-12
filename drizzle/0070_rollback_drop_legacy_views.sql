-- ──────────────────────────────────────────────────────────────────────────
-- Rollback for 0070 — re-create the backward-compat VIEWs.
--
-- Use this if a tooling script or external consumer must read from the
-- legacy table names (`target_websites`, `integration_destinations`) again.
-- `CREATE OR REPLACE VIEW` is idempotent.
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW target_websites AS SELECT * FROM destinations;
CREATE OR REPLACE VIEW integration_destinations AS SELECT * FROM integration_routes;
