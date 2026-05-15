-- ──────────────────────────────────────────────────────────────────────────
-- Migration 0090 — add orders.offerName.
--
-- The Phase 4 follow-up pagination sync now reads `offer.name` from
-- sotuvchi's /getOrders response (verified via probe 2026-05-15).
-- Persisting it next to the existing orders.offerId snapshot lets the
-- Insights UI render real offer names ("Yurak ursa bas") instead of raw
-- numeric ids in the offer breakdown — and avoids ever joining to an
-- external offers catalog at query time.
--
-- Denormalised on purpose:
--   • Sotuvchi can rename offers over time. We capture the name at sync
--     time so historical rollups always reflect what the offer was
--     called WHEN the order moved through it.
--   • Eliminates a JOIN-per-breakdown in the insights router.
--
-- Idempotency: guarded by information_schema lookup.
-- Cost: MySQL 8 InnoDB ADD COLUMN with no default + nullable = INSTANT DDL.
--
-- Rollback: see 0090_rollback_orders_offer_name.sql.
-- ──────────────────────────────────────────────────────────────────────────

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'orders'
     AND column_name = 'offerName'
);
SET @stmt := IF(@col_exists = 0,
  'ALTER TABLE orders ADD COLUMN offerName VARCHAR(255) NULL DEFAULT NULL',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;
