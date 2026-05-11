-- Migration 0068 — Per-app rate pooling for the circuit breaker.
--
-- Adds `appKey` to `integration_health` so the breaker can answer "are any
-- siblings of this destination's app currently open?" without an expensive
-- JOIN through `integration_destinations` + `target_websites` on every claim.
--
-- Scenario this unlocks: when 100k.uz starts 429ing, the FIRST destination
-- to fail opens its row + sets its appKey to `100k`. Subsequent claims for
-- DIFFERENT 100k destinations see a sibling already OPEN and back off
-- without even attempting the call — saving up to N-1 wasted requests per
-- outage (we have 18 distinct 100k destinations in prod right now).
--
-- The column is nullable: existing rows keep working until backfilled, and
-- destinations whose appKey can't be resolved (legacy single-dest, unknown
-- template) stay in per-destination-only mode without breaking.

--> statement-breakpoint
ALTER TABLE `integration_health`
  ADD COLUMN `appKey` VARCHAR(64) DEFAULT NULL AFTER `destinationId`,
  ADD KEY `idx_integration_health_appkey_state` (`appKey`, `state`);
