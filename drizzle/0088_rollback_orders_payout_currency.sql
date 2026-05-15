-- Rollback for 0088 — drops orders.payoutCurrency. Loses the per-row
-- currency tag for payouts captured since the forward migration ran;
-- payoutAmount values stay but become unattributable to a currency.

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'orders'
     AND column_name = 'payoutCurrency'
);
SET @stmt := IF(@col_exists >= 1,
  'ALTER TABLE orders DROP COLUMN payoutCurrency',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;
