-- After: pnpm db:backfill:crm-final
-- Canonical crmStatus: lowercase snake (new, contacted, in_progress, success, delivered, …).

-- 1) Distribution
SELECT crmStatus, COUNT(*) AS n
FROM orders
GROUP BY crmStatus
ORDER BY n DESC;

-- 2) UNKNOWN breakdown (extend shared/crmStatuses if new raw strings appear)
SELECT crmRawStatus, COUNT(*) AS n
FROM orders
WHERE crmStatus = 'unknown'
GROUP BY crmRawStatus
ORDER BY n DESC;

-- 3a) Mapping coverage: non-empty raw but still `unknown` (expect tiny share of all orders; extend mappers if this grows)
SELECT COUNT(*) AS n_raw_but_unknown
FROM orders
WHERE crmRawStatus IS NOT NULL
  AND TRIM(crmRawStatus) <> ''
  AND crmStatus = 'unknown';

-- 3b) Ratio vs orders with raw (manual: n_raw_but_unknown / COUNT(*) WHERE raw present)
-- 3) Normalized “cancelled” must not hide distinct raw outcomes
SELECT id, crmStatus, crmRawStatus, isFinal
FROM orders
WHERE crmStatus = 'cancelled'
  AND crmRawStatus IN ('client_returned', 'trash', 'not_sold', 'not_sold_group')
LIMIT 50;

-- 4) isFinal rows: terminal normalized statuses only (same check as script assertFinalRowsTerminal)
-- Expected: 0 “suspicious” rows after healthy sync + mapping. (Archived is terminal in FINAL_STATUSES.)
SELECT COUNT(*) AS suspicious_isFinal_non_terminal
FROM orders
WHERE isFinal = 1
  AND crmStatus NOT IN (
    'delivered',
    'cancelled',
    'returned',
    'not_delivered',
    'trash',
    'not_sold',
    'archived'
  );

-- 5) Optional: Sotuvchi-oriented “already matches CASE(raw)” (not 100k-accurate without appKey join — use for ballpark only;
--    keep CASE in sync with shared/crmStatuses mapSotuvchiRawToNormalized).
SELECT COUNT(*) AS likely_already_normalized
FROM orders o
WHERE o.isFinal = 1
  AND o.crmRawStatus IS NOT NULL
  AND TRIM(o.crmRawStatus) <> ''
  AND o.crmStatus = (
    CASE
      WHEN LOWER(TRIM(o.crmRawStatus)) IN ('request', 'new') THEN 'new'
      WHEN LOWER(TRIM(o.crmRawStatus)) IN ('accepted', 'filling', 'order') THEN 'contacted'
      WHEN LOWER(TRIM(o.crmRawStatus)) IN ('sent', 'booked', 'preparing', 'recycling', 'on_argue', 'callback') THEN 'in_progress'
      WHEN LOWER(TRIM(o.crmRawStatus)) = 'sold' THEN 'success'
      WHEN LOWER(TRIM(o.crmRawStatus)) = 'delivered' THEN 'delivered'
      WHEN LOWER(TRIM(o.crmRawStatus)) IN ('cancelled', 'canceled') THEN 'cancelled'
      WHEN LOWER(TRIM(o.crmRawStatus)) = 'product_out_of_stock' THEN 'not_sold'
      WHEN LOWER(TRIM(o.crmRawStatus)) = 'client_returned' THEN 'returned'
      WHEN LOWER(TRIM(o.crmRawStatus)) = 'not_delivered' THEN 'not_delivered'
      WHEN LOWER(TRIM(o.crmRawStatus)) = 'trash' THEN 'trash'
      WHEN LOWER(TRIM(o.crmRawStatus)) IN ('not_sold', 'not_sold_group') THEN 'not_sold'
      WHEN LOWER(TRIM(o.crmRawStatus)) = 'archived' THEN 'archived'
      ELSE 'unknown'
    END
  );
