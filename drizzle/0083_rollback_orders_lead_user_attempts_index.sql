-- Rollback for 0083 — drop the covering index. Guarded + idempotent.

SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.statistics
   WHERE table_schema = DATABASE()
     AND table_name = 'orders'
     AND index_name = 'idx_orders_lead_user_attempts'
);
SET @stmt := IF(@idx_exists >= 1,
  'DROP INDEX idx_orders_lead_user_attempts ON orders',
  'DO 0');
PREPARE p FROM @stmt; EXECUTE p; DEALLOCATE PREPARE p;
