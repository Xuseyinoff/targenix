# tooling/

Off-track scripts: audits, migrations, one-off diagnostics. Not part of the
production runtime — only invoked manually or via `pnpm` scripts in
`package.json`.

## Organization policy (2026-05-12)

Pick the prefix that matches a script's purpose and lifecycle. New scripts
without a clear prefix get pushed back in code review.

### `audit-*.ts` / `audit-*.mjs` — Read-only audits

Survey DB state, schema coverage, or codebase patterns. **Idempotent and
safe to re-run.** Keep indefinitely — they're regression-detectors.

Examples:
- `audit-deprecated-adapters.ts` — counts deprecated adapter usage; should
  always return 0 after the 2026-05-12 cleanup.
- `audit-multi-dest-coverage.ts` — verifies `integration_destinations`
  covers every active LEAD_ROUTING integration.
- `audit-unused-deps.mjs` — finds npm packages with zero importers.
- `audit-unused-ui-components.mjs` — cross-references shadcn/ui components.
- `audit-appkey-coverage.ts` — verifies `target_websites.appKey` is set.

### `apply-*.ts` / `apply-*.mjs` — One-shot migrations

Apply a specific DB migration or backfill. **Archive when the work
documented in the script name is more than ~6 months old AND the change is
no longer reversible from the SQL alone.**

Examples:
- `apply-migration-0067.ts` — circuit breaker tables.
- `apply-0043.mjs` — destination_templates category column.

### `backfill-*.ts` / `backfill-*.mjs` — One-shot data migrations

Re-shape existing data after a schema change. **Idempotent** (otherwise
they should be a regular migration). Keep until the underlying schema
change is irreversible.

Examples:
- `backfill-orders-destination-id.ts`
- `backfill-orphan-retries.ts`
- `mysql/backfill-integration-destinations.mjs` — referenced by code
  comments as the canonical drift-reconciliation script.

### `check-*.ts` / `check-*.mjs` — One-shot diagnostics

Quick "is X broken right now?" probes. **Disposable** — delete once the
ticket is resolved unless the script has become a recurring sanity check.

Examples:
- `check-recent-orders.ts`
- `check-pending.mjs`
- `check-retry-queue.ts`

### `inspect-*.ts` — Deep-dive investigations

Like `check-*` but more verbose; usually written during a specific
incident. **Disposable.**

### `debug-*.ts` / `explore-*.ts` — Throwaway scratch

Definitely disposable. Don't commit these unless they teach something
non-obvious that should outlive the investigation.

## Subdirectories

- `mysql/` — raw mysql2 backfill / sync scripts (no Drizzle, no TS).
  Used when the schema is mid-migration and the Drizzle types don't yet
  reflect reality.
- `drizzle/` — Drizzle-aware migrations / backfills.
- `railway/` — Railway-specific (CLI wrappers, redeploy automation).
- `hubspot-apps/` — Separate HubSpot UI extension project, unrelated to
  the targenix runtime.

## Running

Most scripts are TS and expect Drizzle/MySQL to be reachable:

```bash
# Local DB (uses .env DATABASE_URL)
npx tsx tooling/audit-deprecated-adapters.ts

# Railway production DB
railway run --service WORKER npx tsx tooling/audit-deprecated-adapters.ts
```

The `mysql/*.mjs` scripts use raw `mysql2/promise` and read
`MYSQL_PUBLIC_URL` / `MYSQL_URL` / `DATABASE_URL` in that order.

## Bundle-size guard

`check-bundle-size.mjs` is run via `pnpm check:bundle-size` after `vite
build` and asserts every JS chunk's gzipped size stays under its budget.
See the file header for budget rationale.

## Untracked files

Many `debug-*` / `inspect-*` / `explore-*` scripts in this directory are
intentionally `.gitignore`'d-by-not-tracking — they were written for a
single investigation and aren't worth versioning. If a script proves
generally useful, rename it with the appropriate prefix above and
`git add` it.
