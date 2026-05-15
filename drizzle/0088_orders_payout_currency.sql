-- ──────────────────────────────────────────────────────────────────────────
-- Migration 0088 — add orders.payoutCurrency (Phase 3).
--
-- Pairs with the existing orders.payoutAmount column (added in 0085). The
-- amount alone isn't safe to sum into a multi-currency rollup — without
-- knowing what currency it's in we'd silently treat 35,000 UZS as $35,000.
--
-- Source: sotuvchi's /getOrderDetails returns `order.pay_for` as an integer
-- in the platform's domestic currency (UZS for sotuvchi). The Phase 3 CRM
-- sync writes both payoutAmount and payoutCurrency='UZS' together. The
-- rollup worker uses the currency to short-circuit when it doesn't match
-- the user's baseCurrency (v1: no FX conversion).
--
-- Idempotency: guarded by information_schema lookup.
-- Cost: MySQL 8 InnoDB ADD COLUMN with constant default → INSTANT DDL.
-- Rollback: see 0088_rollback_orders_payout_currency.sql.
-- ──────────────────────────────────────────────────────────────────────────

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'orders'
     AND column_name = 'payoutCurrency'
);
SET @stmt := IF(@col_exists = 0,
  'ALTER TABLE orders ADD COLUMN payoutCurrency VARCHAR(8) NULL DEFAULT NULL',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;
