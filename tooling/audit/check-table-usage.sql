-- =============================================================================
-- Targenix.uz — DB usage audit queries
-- Run against PRODUCTION read-replica (or production with care).
-- These are read-only. Save results, do not act on them blindly.
-- =============================================================================

-- 1. Tables ranked by size + last update time
--    Use this to spot:
--      - Bloat (huge data_length for low row counts → fragmentation)
--      - Cold tables (update_time months old → likely candidates for archive/drop)
SELECT
  table_name,
  table_rows                                     AS approx_rows,
  ROUND((data_length + index_length) / 1024 / 1024, 2) AS total_mb,
  ROUND(data_length  / 1024 / 1024, 2)           AS data_mb,
  ROUND(index_length / 1024 / 1024, 2)           AS index_mb,
  update_time
FROM information_schema.tables
WHERE table_schema = DATABASE()
ORDER BY total_mb DESC;

-- 2. Indexes that have NEVER been used since last server restart
--    Requires performance_schema enabled (default on MySQL 8+).
--    A row here = candidate for DROP INDEX after confirming no nightly batch uses it.
SELECT
  object_schema,
  object_name,
  index_name,
  count_star AS reads_since_restart
FROM performance_schema.table_io_waits_summary_by_index_usage
WHERE index_name IS NOT NULL
  AND count_star = 0
  AND object_schema = DATABASE()
  AND index_name <> 'PRIMARY'
ORDER BY object_name, index_name;

-- 3. Top 10 most-read tables vs least-read (concrete drop candidates)
SELECT
  object_schema,
  object_name,
  SUM(count_read)  AS total_reads,
  SUM(count_write) AS total_writes
FROM performance_schema.table_io_waits_summary_by_table
WHERE object_schema = DATABASE()
GROUP BY object_schema, object_name
ORDER BY total_reads ASC
LIMIT 10;

-- 4. Per-table NULL ratios on columns that look like they should be required
--    (Picks the columns most often misused — adjust to your top tables.)
--    Run one per high-row-count table identified in (1).
--    Example for `leads`:
--
--    SELECT
--      COUNT(*) AS total_rows,
--      SUM(email      IS NULL OR email = '')      AS null_email,
--      SUM(phone      IS NULL OR phone = '')      AS null_phone,
--      SUM(fullName   IS NULL OR fullName = '')   AS null_fullname,
--      SUM(pageId     IS NULL OR pageId = '')     AS null_pageId,
--      SUM(formId     IS NULL OR formId = '')     AS null_formId,
--      SUM(campaignId IS NULL OR campaignId = '') AS null_campaignId
--    FROM leads;

-- 5. Tenant-scoped tables — verify userId index actually exists
--    Cross-reference with drizzle/schema.ts. Any tenant-scoped table without
--    an index containing userId as a leading column is a slow-query bomb.
SELECT
  t.table_name,
  GROUP_CONCAT(DISTINCT s.index_name ORDER BY s.index_name SEPARATOR ', ') AS indexes_with_userid
FROM information_schema.tables t
LEFT JOIN information_schema.statistics s
  ON s.table_schema = t.table_schema
 AND s.table_name   = t.table_name
 AND s.seq_in_index = 1
 AND s.column_name  = 'userId'
WHERE t.table_schema = DATABASE()
  AND t.table_name IN (
    'telegram_chats','password_reset_tokens','facebook_accounts',
    'facebook_connections','facebook_forms','oauth_states','oauth_tokens',
    'connections','destinations','integrations','leads','orders',
    'order_events','app_logs','ad_accounts','campaigns','ad_sets',
    'campaign_insights','crm_connections'
  )
GROUP BY t.table_name
ORDER BY t.table_name;

-- 6. Orphan-row detection — orders pointing at a deleted/missing integration
--    (Phase 1 noted ~11k orphan orders pre-soft-delete fix on 2026-05-15.)
SELECT COUNT(*) AS orphan_orders
FROM orders o
LEFT JOIN integrations i ON i.id = o.integrationId
WHERE i.id IS NULL;

-- 7. Migration journal vs migration files — mismatch detection
--    Compare the rows here against drizzle/meta/_journal.json on disk.
SELECT hash, created_at
FROM `__drizzle_migrations`
ORDER BY id DESC
LIMIT 50;

-- 8. Stale soft-deleted integrations (deletedAt set but orders still associated)
SELECT
  i.id,
  i.deletedAt,
  COUNT(o.id) AS attached_orders
FROM integrations i
JOIN orders o ON o.integrationId = i.id
WHERE i.deletedAt IS NOT NULL
GROUP BY i.id, i.deletedAt
ORDER BY i.deletedAt;

-- 9. app_logs retention sanity — oldest row + total row count
--    Verifies logRetentionScheduler is actually pruning.
SELECT
  COUNT(*)         AS total_log_rows,
  MIN(createdAt)   AS oldest_log,
  MAX(createdAt)   AS newest_log
FROM app_logs;

-- 10. Tables with zero rows (candidates for deletion if also unused in code)
SELECT table_name
FROM information_schema.tables
WHERE table_schema = DATABASE()
  AND table_rows = 0
ORDER BY table_name;
