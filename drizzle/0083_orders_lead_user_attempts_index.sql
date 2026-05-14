-- ──────────────────────────────────────────────────────────────────────────
-- Migration 0083 — covering index for the leads "has been routed?" EXISTS
-- subquery.
--
-- Context: getLeads / getLeadsCount / getLeadStats all gate visibility on
--   EXISTS (SELECT 1 FROM orders
--            WHERE orders.leadId = leads.id
--              AND orders.userId = ?
--              AND orders.attempts > 0)
-- No index covered this. EXPLAIN showed the orders side using
-- idx_orders_user_status (userId, status) then scanning ~40k rows with
-- "Using temporary; Using filesort" — ~700ms warm for a single
-- getLeadsCount call on the local dataset (146k leads / 82k orders).
-- Flagged as a P1 in the 2026-05 architecture audit.
--
-- Fix: composite index (userId, leadId, attempts).
--   • userId    — the EXISTS subquery's semi-join is driven by the orders
--                 table filtered on userId; this MUST be the leading
--                 column or MySQL keeps falling back to
--                 idx_orders_user_status (verified — a leadId-first index
--                 was ignored by the optimizer).
--   • leadId    — the correlation key (orders.leadId = leads.id).
--   • attempts  — range filter (> 0).
-- With all three columns indexed the semi-join becomes a covering
-- "Using index" LooseScan — no table row lookups, no temp/filesort on the
-- COUNT path. Measured on local (40k orders for the busiest user):
--   getLeadsCount 691ms → 372ms (~2x); EXPLAIN Extra goes from
--   "Using temporary; Using filesort" to "Using index; LooseScan".
-- The full ~10x win needs a denormalized leads.hasRoutedOrders boolean —
-- tracked as a separate task; this index is the zero-risk first step.
--
-- Cost: MySQL 8 InnoDB CREATE INDEX is ONLINE (ALGORITHM=INPLACE) — no
-- table rebuild, reads + writes continue during the build. On a ~100k-row
-- orders table it completes in a few seconds.
--
-- Idempotency: guarded — skipped if the index already exists.
--
-- Rollback: see 0083_rollback_orders_lead_user_attempts_index.sql.
-- ──────────────────────────────────────────────────────────────────────────

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'orders'
     AND index_name = 'idx_orders_lead_user_attempts'
);
SET @stmt := IF(@idx_exists = 0,
  'CREATE INDEX idx_orders_lead_user_attempts ON orders (userId, leadId, attempts)',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;
