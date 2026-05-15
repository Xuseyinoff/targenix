-- Rollback for 0090 — drop orders.offerName.
--
-- No permanent data loss: offerName is rederivable by re-running the
-- pagination sync, which reads `offer.name` from sotuvchi on every cycle.

SET @col_exists := (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE()
     AND table_name = 'orders'
     AND column_name = 'offerName'
);
SET @stmt := IF(@col_exists >= 1,
  'ALTER TABLE orders DROP COLUMN offerName',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;
