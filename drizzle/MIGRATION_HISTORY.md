# Migration history & known drift

This document records the historical state of `drizzle/meta/_journal.json`
and the production `__drizzle_migrations` table, plus the in-progress
reconciliation.

## Layout

- **Disk:** `drizzle/NNNN_<tag>.sql` — every numbered migration file.
  Paired `NNNN_rollback_<tag>.sql` exists for every migration since 0069
  (defensive — kept since the destinations rename incident).
- **Local journal:** `drizzle/meta/_journal.json` — what `drizzle-kit`
  reads to determine the list of migrations.
- **Production tracking table:** `__drizzle_migrations` — what
  `drizzle-kit migrate` consults at deploy time. Stores `id`, `hash`
  (sha256 of the `.sql` file content), `created_at` (ms timestamp).

For `drizzle-kit migrate` to be safe, the journal must match the prod
table. When they drift, the next deploy either re-runs an already-
applied migration (idempotency hazard) or fails outright.

## Numbering convention

- Sequential 4-digit zero-padded integers: `0000`, `0001`, …
- Two sources of historical drift you'll see in `git log` and `ls`:
  1. **Duplicate numbers** — same number, different content. Result of
     a squashed/rebased local branch where two devs both took the next
     free number. Currently: `0025` (×2), `0027` (×2).
  2. **Gaps in numbering** — numbers that were never used on disk.
     Currently: `0057`, `0059`. The team simply jumped over them when
     drizzle-kit suggested a number that had been speculatively taken.

## Known drift (as of 2026-05-17 Phase 2 audit)

### Reconciled in this commit (8 entries)

These migrations had DDL applied to prod (via `tooling/apply-NNNN-*.mjs`)
but were **never tracked** in either the journal or `__drizzle_migrations`.
Backfilled by `tooling/drizzle/backfill-migration-journal-phase2.mjs`:

| File | Idx (new) | Why missing |
|---|---|---|
| 0054_drop_connection_app_specs | 81 | Applied via earlier migrate run that didn't persist the journal entry. |
| 0060_drop_connections_google_account_id_final | 82 | Same. |
| 0085_insights_phase1 | 83 | Applied via `tooling/apply-0085-insights-phase1.mjs`. |
| 0086_campaign_daily_insights | 84 | `tooling/apply-0086-*.mjs`. |
| 0087_insights_fix_collation | 85 | `tooling/apply-0087-*.mjs`. |
| 0088_orders_payout_currency | 86 | `tooling/apply-0088-*.mjs`. |
| 0089_insights_phase4_fx_and_pipeline | 87 | `tooling/apply-0089-*.mjs`. |
| 0090_orders_offer_name | 88 | `tooling/apply-0090-*.mjs`. |

### Out-of-scope (intentionally NOT reconciled)

The Phase 2 probe ([tooling/audit/probe-migration-state.mjs](../tooling/audit/probe-migration-state.mjs))
revealed 19 additional missing rows in `__drizzle_migrations`:

| File(s) | Status in journal | Status in DB | Artifact in prod |
|---|---|---|---|
| 0030_telegram_delivery_chats | ✓ idx 30 | ✗ missing | ✓ |
| 0031_target_website_telegram_chat | ✓ idx 31 | ✗ missing | ✓ |
| 0042_destination_templates_category | ✓ idx 42 | ✗ missing | ✓ |
| 0043_connections | ✓ idx 43 | ✗ missing | ✓ |
| 0044_integration_destinations | ✓ idx 44 | ✗ missing | ✓ |
| 0045_orders_destination_id | ✓ idx 45 | ✗ missing | ✓ |
| 0069_rename_destinations | ✓ idx 65 | ✗ missing | ✓ |
| 0070_drop_legacy_views | ✓ idx 66 | ✗ missing | ✓ |
| 0071_rename_target_website_id_column | ✓ idx 67 | ✗ missing | ✓ |
| 0072_rewrite_cfg_target_website_id | ✓ idx 68 | ✗ missing | ✓ |
| 0073_rename_legacy_index_names | ✓ idx 69 | ✗ missing | ✓ |
| 0074_rename_cache_and_circuit_breakers | ✓ idx 70 | ✗ missing | ✓ |
| 0075_rename_legacy_index_names_v2 | ✓ idx 71 | ✗ missing | ✓ |
| 0076_drop_legacy_views_v2 | ✓ idx 72 | ✗ missing | ✓ |
| 0077_drop_templatetype_column | ✓ idx 73 | ✗ missing | ✓ |
| 0078_users_password_changed_at | ✓ idx 74 | ✗ missing | ✓ |
| 0079_lead_retry_state | ✓ idx 75 | ✗ missing | ✓ |
| 0083_orders_lead_user_attempts_index | ✓ idx 79 | ✗ missing | ✓ |
| 0084_telegram_pending_chats_claimed_by | ✓ idx 80 | ✗ missing | ✓ |

**Why deferred:** This commit's scope (Phase 2 audit) covered only the 8
audit-flagged entries. The older drift is harmless under current
operating practice because the team does NOT routinely run `db:push`
or `drizzle-kit migrate`; every schema change ships as a dedicated
`tooling/apply-NNNN-*.mjs` script that runs the SQL directly. If `db:push`
is ever re-enabled as the primary migration path, this remaining drift
must be reconciled first (extend `backfill-migration-journal-phase2.mjs`
to cover the additional 19 rows).

### Ghost rows in `__drizzle_migrations` (2 entries)

The probe found two rows in `__drizzle_migrations` with hashes that
match NO disk file:

| DB id | hash | created_at | Likely origin |
|---|---|---|---|
| 52 | `425baaad1cc78dd4cff8d8d6be29ff1e9959fc326b56899250ed3cb404504919` | 1778006401000 (May 5) | Probably the original `0057_*` or `0059_*` migration whose file was later deleted (those numbers are now gaps in numbering). |
| 53 | `7e4b1a15136cee50c78fd4834ba2fe1224d032172217741c88fca288eb26f9b7` | 1778006410000 (May 5) | Same. |

These are harmless: `drizzle-kit migrate` only reads the journal and
checks each entry against the DB; **extra** DB rows are ignored. They
remain as forensic evidence of the drift's origin. Leave alone.

### Orphan-numbered files (2 entries)

Two files on disk have duplicate numbers AND no journal entry AND no
DB row, yet their schema artifacts exist in prod:

| File | Artifact in prod | Why orphan |
|---|---|---|
| 0025_password_reset_tokens.sql | ✓ `password_reset_tokens` table exists | DDL probably bundled into `0025_absent_rage.sql` at the time, or run via one-shot script that's since been deleted. |
| 0027_destination_templates.sql | ✓ `destination_templates` table exists | Same. |

**Why deferred:** Adding them to the journal would require an idx
allocation AND a backfill row in `__drizzle_migrations`. Since the DDL
they declare is already present in prod, doing so adds tracking but
doesn't change runtime behaviour. Out of scope for Phase 2; documented
for future cleanup.

## CI guard

[tooling/audit/check-journal-integrity.mjs](../tooling/audit/check-journal-integrity.mjs)
runs as part of `pnpm check:journal` and the CI workflow. It enforces:

1. Every disk `NNNN_<tag>.sql` (excluding rollbacks) has a matching
   journal entry — EXCEPT for the known orphans listed above (allowlisted).
2. The journal's `idx` sequence is monotonic.
3. No journal entry references a non-existent disk file.

Future drift will fail CI immediately rather than accumulating.

## How to add a new migration

1. **Schema change in code:** edit `drizzle/schema.ts`.
2. **Generate migration file:**
   ```bash
   pnpm exec drizzle-kit generate
   ```
   This creates `drizzle/NNNN_<tag>.sql` AND adds an entry to
   `_journal.json` AND writes a `drizzle/meta/NNNN_snapshot.json`.
3. **Apply via dedicated script (current team practice):**
   - Copy the pattern from `tooling/apply-0090-orders-offer-name.mjs`
     (which describes the DDL + runs it idempotently)
   - Save as `tooling/apply-NNNN-<tag>.mjs`
   - Run: `railway run node tooling/apply-NNNN-<tag>.mjs`
4. **Backfill the migration row:**
   - After applying, INSERT into `__drizzle_migrations`:
     ```js
     await conn.query(
       "INSERT INTO `__drizzle_migrations` (`hash`, `created_at`) VALUES (?, ?)",
       [hashFromSql, Date.now()],
     );
     ```
   - OR add to `backfill-migration-journal-phase2.mjs` and re-run.
5. **Verify with the probe:**
   ```bash
   railway run node tooling/audit/probe-migration-state.mjs
   ```
6. **Commit** the new `.sql`, updated `_journal.json`, and the
   snapshot. CI will run `pnpm check:journal` to validate consistency.

## Reconciliation log

- **2026-05-17** — Phase 2 audit commit. Backfilled 8 entries (0054, 0060,
  0085-0090). 19 older drift entries documented above, deferred.
- **2026-04-16** — `tooling/drizzle/backfill-migration-journal-0026-0027.mjs`
  added 2 DB rows for 0026 and 0027 (`__drizzle_migrations` was missing
  them after a partial recovery).
