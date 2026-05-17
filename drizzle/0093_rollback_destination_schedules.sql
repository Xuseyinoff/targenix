-- ──────────────────────────────────────────────────────────────────────────
-- Rollback for 0093 — drops both new tables created by Yuboraman PR 4/4 A.
--
-- Order: drop the child queue table first (destination_pending_leads),
-- then the parent schedule table. No FK is declared between them at the
-- DB level, but the logical dependency is "pending leads belong to a
-- scheduled destination" — keeping the drop order consistent with that
-- relationship makes the intent clearer if a future audit grep'd this
-- file for ordering issues.
--
-- Idempotent: DROP TABLE IF EXISTS.
-- ──────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS `destination_pending_leads`;
DROP TABLE IF EXISTS `destination_schedules`;
