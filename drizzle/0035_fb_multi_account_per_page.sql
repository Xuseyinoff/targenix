-- Allow the same Facebook page to be connected independently via multiple FB accounts.
-- Previously: UNIQUE (userId, pageId) — one page per user.
-- Now:        UNIQUE (userId, facebookAccountId, pageId) — one page per (user, fb account).
-- Existing data is unaffected: all current rows already satisfy the new constraint.

ALTER TABLE facebook_connections
  DROP INDEX uq_facebook_connections_user_page,
  ADD UNIQUE KEY uq_fb_conn_user_account_page (userId, facebookAccountId, pageId);
