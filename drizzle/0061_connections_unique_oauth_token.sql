-- Migration 0061 — Add unique constraint on connections(userId, oauthTokenId)
--
-- Purpose: prevents duplicate connection rows from concurrent OAuth callbacks
--          (SELECT→INSERT race replaced by INSERT … ON DUPLICATE KEY UPDATE).
--
-- Safe because:
--   • oauthTokenId is nullable — MySQL allows multiple NULLs in unique indexes,
--     so telegram_bot / api_key connections (oauthTokenId IS NULL) are unaffected.
--   • Precondition: no duplicate (userId, oauthTokenId) pairs should exist. Verify:
--     SELECT userId, oauthTokenId, COUNT(*) FROM connections
--     WHERE oauthTokenId IS NOT NULL
--     GROUP BY userId, oauthTokenId HAVING COUNT(*) > 1;  -- must return 0 rows

--> statement-breakpoint
ALTER TABLE `connections`
  ADD UNIQUE INDEX `uniq_connections_user_oauth_token` (`userId`, `oauthTokenId`);
