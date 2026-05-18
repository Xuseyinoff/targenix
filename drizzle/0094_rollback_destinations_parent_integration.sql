-- ──────────────────────────────────────────────────────────────────────────
-- Rollback for 0094 — drops the parentIntegrationId column and its index.
--
-- WARNING: any rows with parentIntegrationId set become orphan privates
-- after this rollback (i.e. they re-appear in the destination picker as
-- shared destinations of their owning user). PR 3 will introduce the
-- cleanup cascade — once that's live, rolling back this column without
-- first running the cascade leaves UI duplicates the user can't easily
-- clean up. Apply only if you're certain no parentIntegrationId values
-- have been set yet.
--
-- Order: drop the index before the column (MySQL allows either, but the
-- explicit order makes the intent reviewable).
-- ──────────────────────────────────────────────────────────────────────────

DROP INDEX `idx_destinations_parent_integration` ON `destinations`;

ALTER TABLE `destinations`
  DROP COLUMN `parentIntegrationId`,
  ALGORITHM=INPLACE, LOCK=NONE;
