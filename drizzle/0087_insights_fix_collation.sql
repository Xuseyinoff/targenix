-- ──────────────────────────────────────────────────────────────────────────
-- Migration 0087 — fix collation on Insights tables.
--
-- Problem:
--   Phase 1 migration 0085 (fact_attribution_daily) and Phase 2 migration
--   0086 (campaign_daily_insights) both ended with
--     `… COLLATE=utf8mb4_unicode_ci`
--   but the prod database default is `utf8mb4_0900_ai_ci` (MySQL 8 default).
--   Every other Targenix table inherits that default, so any JOIN /
--   comparison between an Insights column and a non-Insights column
--   blows up with:
--
--     ER_CANT_AGGREGATE_2COLLATIONS
--     "Illegal mix of collations (utf8mb4_unicode_ci, IMPLICIT) and
--                                 (utf8mb4_0900_ai_ci, IMPLICIT) for
--      operation '='"
--
--   The rollup worker fails on the `cs.currency = ?` predicate (cs is the
--   campaign_daily_insights row; `?` is a parameter bound with the
--   connection's default collation = 0900_ai_ci). Result: 0 rollup writes
--   since Phase 2 shipped.
--
-- Fix:
--   Convert both Insights tables to the DB default. CONVERT TO CHARACTER
--   SET propagates the new collation to every text column on the table
--   and is a single metadata-only operation in MySQL 8 InnoDB. No data
--   is lost.
--
-- Idempotency:
--   The ALTERs run unconditionally — re-running with the table already at
--   the target collation is a no-op (MySQL skips). Safe to re-run.
--
-- Cost:
--   Metadata-only on MySQL 8 InnoDB for utf8mb4 → utf8mb4 (same character
--   set, different collation). No table rewrite, no row lock.
--
-- Rollback: see 0087_rollback_insights_fix_collation.sql (reverts to the
--   previous explicit utf8mb4_unicode_ci — but you almost certainly don't
--   want to roll back, since the original collation is what caused the
--   problem).
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE `fact_attribution_daily`
  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

ALTER TABLE `campaign_daily_insights`
  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
