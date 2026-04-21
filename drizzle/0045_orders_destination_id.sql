-- Migration 0045: orders.destinationId + per-destination unique key.
--
-- Phase 4 / Commit 6a. ADDITIVE ONLY — zero behaviour change.
--
-- Goal: prepare the `orders` table for Commit 6b (multi-destination fan-out),
-- where one LEAD_ROUTING integration can deliver a single lead to N
-- destinations. Today an `orders` row represents a single (lead, integration)
-- pair, and the unique key `uq_orders_lead_integration` enforces that — which
-- blocks N > 1 because the flag-on code path needs to insert one row per
-- destination to track per-destination retry state.
--
-- Strategy:
--   * Add a `destinationId` column defaulted to 0. Legacy rows stay at 0.
--     When Commit 6b lands, the new multi-destination code path writes the
--     `integration_destinations.id` of the mapping it is delivering to; the
--     legacy path continues to use 0 forever.
--   * Swap the old 2-tuple unique key for a 3-tuple `(leadId, integrationId,
--     destinationId)` so the legacy path (destinationId = 0) still has its
--     idempotency guarantee, and the new path gets a parallel guarantee
--     per destination.
--   * Add a secondary index on `destinationId` alone for future analytics
--     ("which orders were delivered to this destination mapping?").
--
-- Why destinationId = 0 instead of NULL?
--   MySQL allows multiple NULLs in a UNIQUE index, so a NULL sentinel would
--   silently break the idempotency of the legacy path — two simultaneous
--   retries could insert two rows. A non-null integer default has no such
--   edge case and keeps the unique key strict. The schema column is
--   `INT NOT NULL DEFAULT 0`, never nullable.
--
-- Zero behaviour change at deploy time:
--   * All pre-existing rows get destinationId = 0 from the DEFAULT clause.
--   * No code in leadService/retry touches destinationId yet (Commit 6a
--     only updates the Drizzle type surface — callers still omit the
--     column on insert, so the default fires).
--   * aggregateLeadDeliveryFromOrderStatuses already supports the PARTIAL
--     state we'll rely on in Commit 6b.
--
-- Operational notes:
--   * On MySQL 8.0+ `ADD COLUMN … NOT NULL DEFAULT 0` is typically executed
--     via the INSTANT algorithm — no table copy, no lock.
--   * Dropping and recreating the unique key involves a brief online DDL
--     but the orders table is small for this project; expect sub-second on
--     the Railway instance.
--
-- Rollback path (reverse-migration, one-shot):
--   ALTER TABLE orders DROP INDEX uq_orders_lead_int_dest;
--   ALTER TABLE orders ADD UNIQUE KEY uq_orders_lead_integration (leadId, integrationId);
--   ALTER TABLE orders DROP INDEX idx_orders_destination;
--   ALTER TABLE orders DROP COLUMN destinationId;
-- Requires zero rows with destinationId <> 0 to be safe — which holds until
-- Commit 6b is enabled under the feature flag.

--> statement-breakpoint
ALTER TABLE `orders`
  ADD COLUMN `destinationId` INT NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `orders`
  DROP INDEX `uq_orders_lead_integration`;
--> statement-breakpoint
ALTER TABLE `orders`
  ADD CONSTRAINT `uq_orders_lead_int_dest`
    UNIQUE (`leadId`, `integrationId`, `destinationId`);
--> statement-breakpoint
ALTER TABLE `orders`
  ADD INDEX `idx_orders_destination` (`destinationId`);
