# Archived tooling scripts

This folder holds scripts that have completed their one-shot purpose
but are kept for historical reference. They should NOT be re-run as
part of any current workflow.

## Structure

- `migrations/` — `apply-NNNN-*.mjs` scripts whose target migration is
  recorded in `__drizzle_migrations` (verified by hash). Each was a
  one-time apply against production. New apply scripts live in
  `tooling/` root until their `__drizzle_migrations` row exists, then
  move here.
- `incidents/` — scripts named with a specific incident ID (e.g.
  `*-1893631.mjs`), moved here once the incident is closed.
- `renames/` — `bulk-rename-*.mjs` codemod scripts after their rename
  push has shipped to `main`. See [[bulk-rename-two-passes]] memory
  note for the convention behind running these in pairs.
- `probes/` — `probe-*`, `debug-*`, `diagnose-*`, and `audit-*` scripts
  from completed investigations. Useful as templates for similar
  follow-up work, but the data they targeted is stale.
- `mysql/` — older staged migration helpers (pre-existing; predates
  this convention).

## Conventions

- Files in `_archive/` are read-only by convention. If you need to
  re-run something, copy it back to `tooling/` root, give it a new
  name if appropriate, and treat it as a new script.
- Never delete from `_archive/` — these are historical evidence and
  reference templates. Disk cost is negligible.
- New one-shots are written in `tooling/` root. They move here only
  after their purpose is done.

## Re-running considerations

Most archived scripts include an idempotent guard (e.g. an
`information_schema` lookup before `CREATE INDEX`, or a `WHERE NOT
EXISTS` before `INSERT`). Re-running is usually safe but pointless.
Some older `apply-NNNN-*.mjs` scripts (pre-0085) do not include
idempotency — read the file header before considering re-execution.

## Inventory

Run `find tooling/_archive -name "*.mjs" -o -name "*.ts" -o -name "*.json" | wc -l`
for a current count, grouped by subfolder with `ls tooling/_archive/*/`.

## What's NOT here

Scripts that are still part of an active workflow stay in `tooling/`
root or in dedicated subfolders:

- `tooling/audit/` — reusable journal / probe scripts used by
  `pnpm check:journal` and ad-hoc audits
- `tooling/drizzle/` — migration backfill helpers referenced by
  `pnpm db:railway:migrate`
- `tooling/mysql/full-sync.mjs`, `tooling/mysql/backfill-crm-status-final.ts`
  — referenced by `pnpm db:sync:railway-to-local` and
  `pnpm db:backfill:crm-final`
- `tooling/check-bundle-size.mjs` — referenced by `pnpm check:bundle-size`
- `tooling/run-100k-crm-sync-once.ts` — referenced by `pnpm crm:sync:100k`
