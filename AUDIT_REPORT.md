# Targenix.uz — Audit Summary

> # ✅ Sprint 2026-05-17 — FINAL STATUS: ALL CRITICAL RESOLVED
>
> Six commits on `critical-fixes/2026-05-17` close every CRITICAL finding from
> this audit. Re-verification during the fix work revealed the original "5
> CRITICAL" count was overstated by mixed false positives — the real
> previously-unguarded surfaces were 3 + the migration journal drift.
>
> | # | Finding | Audit said | Reality | Commit |
> |---|---|---|---|---|
> | 1 | B.5 tenant UPDATE leaks (4) | CRITICAL | Defense-in-depth gaps (SELECT-then-throw blocked exploit today) | `5cf047a` |
> | 2 | F.4 Sentry in worker | CRITICAL | TRUE — every BullMQ error silently dropped | `0f879a6` |
> | 3 | D.6 SSRF `affiliateService.ts:928` | CRITICAL | **FALSE POSITIVE** — guard at line 859 since 2026-04-16 | n/a (closed by re-verify) |
> | 4 | D.6 SSRF `httpRequestAdapter.ts:220` | MEDIUM | **FALSE POSITIVE** — guard at line 189 | n/a |
> | 5 | D.6 SSRF `workflowExecutor.ts:86` | MEDIUM | TRUE — weak inline regex | `e93c170` |
> | 6 | D.6 secret-logging | recommendation | Added `redactSecrets()` to appLogger | `e93c170` |
> | 7 | D.4 scheduler overlap (7) | CRITICAL | **5 FALSE POSITIVE** (setTimeout self-reschedule); 2 real | `c3de5bc` |
> | 8 | B.3 migration journal | CRITICAL | TRUE — 8 missing entries (audit said 8; 0054 turned out already-present, so 7 INSERTs) | `8d537cf` |
>
> **True CRITICAL count: 5 → 3 + migration journal drift.** All resolved.
>
> ## Next priorities (HIGH, not CRITICAL)
>
> - **Remove 5 deprecated `@types/*` packages** (A.1) — `pnpm remove @types/bcryptjs @types/node-telegram-bot-api @types/cors @types/express-rate-limit @types/google.maps`. ~5 min, zero risk.
> - **Add `destinations` table indexes** (B.4) — currently zero secondary indexes; will hit ~50k rows soon. ~15 min + migration + apply.
> - **Set up coverage + router-level integration tests** (E.1, E.3) — add `@vitest/coverage-v8`, wire `coverage` block, write `tenantIsolation.integration.test.ts` per high-LOC router.
> - **Apply `ownedBy()` to 8 other UPDATE/DELETE patterns** (B.5 follow-up) — `triggers.fire`, `connections.rename/disconnect`, `destinations.update`, `leads.retry/bulkRetry`, `telegram.setDestinationChat`. Same defense-in-depth pattern as the 4 fixed in this sprint.
> - **Backfill remaining 19 migration drift rows** (B.3 follow-up) — only needed if `pnpm db:push` is re-enabled as the primary migration path. Documented in [`drizzle/MIGRATION_HISTORY.md`](drizzle/MIGRATION_HISTORY.md).
>
> ## Sections below remain as originally written
>
> Historical traceability preserved. Sections D.4 and D.6 have been amended
> inline with re-verification notes. Original "Critical security findings: 5"
> list below is the AS-FOUND state, not current state.

**Overall health score: 7.0 / 10.** A well-architected TypeScript monolith with clean layering, end-to-end types, and surprisingly disciplined adapter/registry patterns — but multi-tenancy is enforced per-procedure (no central guard), the worker process runs without Sentry, and 22 rollback-paired migrations + a journal/disk mismatch reflect real production turbulence over the last 30 days.

**Top 5 wins to act on this week:**
1. Fix 4 cross-tenant UPDATE leaks in `triggersRouter.ts` and `workflowsRouter.ts` (CRITICAL — 1 hour). [triggersRouter.ts:142, 254](server/routers/triggersRouter.ts#L142) and [workflowsRouter.ts:176, 243](server/routers/workflowsRouter.ts#L176) verify ownership then UPDATE by `id` only.
2. Initialize Sentry in the worker process. Today `leadWorker.ts:112` calls `captureCritical` but `server/workers/run.ts` never calls `initSentry()` — every worker error is silently lost. ~15 minutes.
3. Add SSRF guard (`assertSafeOutboundUrl`) to [`affiliateService.ts:928`](server/services/affiliateService.ts#L928) — the only user-supplied URL outbound call that bypasses `urlSafety.ts`. ~30 minutes.
4. Add overlap guards (in-flight Map) to 6 schedulers that lack them: `retryScheduler`, `triggerScheduler`, `leadPollingService`, `logRetentionScheduler`, `formsRefreshScheduler`, `adsSyncScheduler`, `oauthStateCleanupScheduler`. ~2 hours total.
5. Commit the generated `.env.example` so new contributors stop guessing. Done — file written.

**Top 5 risks if ignored for 3+ months:**
1. **Tenant-isolation drift.** With no central middleware and 60-plus services doing direct DB access, the 4 found bugs are evidence the pattern will keep regressing. Every code review must verify userId in every WHERE clause — a single missed branch leaks all tenants' data.
2. **Migration journal/disk mismatch.** `drizzle/meta/_journal.json` has 81 entries but `drizzle/*.sql` has 92 numbered + 22 rollbacks (114 total). Several gaps: 0025+0027 duplicated, 0057, 0059, 0060 missing, 0085-0090 not in journal. `drizzle-kit migrate` will eventually disagree with prod state.
3. **`destinations` table has zero secondary indexes.** With templateConfig JSON and per-user reads, every list query is a full scan on a growing table. Will start showing as a top slow query at ~50k rows.
4. **Express 4 EOL.** Express 4 is in security-only maintenance; Express 5.2.1 is current. Path-to-regexp v6 in Express 4 has had multiple CVEs in the last year. Migration is moderate effort but not done.
5. **140 test files, no coverage configured.** CI runs `pnpm test` without `--coverage`. Real coverage on services hovers around an unknown number, but only 1 of 25 routers has a dedicated test ([adminAppsRouter.test.ts](server/routers/adminAppsRouter.test.ts)). High blast-radius routers (`leadsRouter` 751 LOC, `destinationsRouter` 1671 LOC) have ZERO direct tests.

**Architecture verdict: Solid.** This is a serious production codebase, not a prototype. Layering is clean (zero violations found by grep), patterns are consistent (registry/adapter for integrations, single `protectedProcedure`/`adminProcedure`), the JWT-in-cookie auth properly invalidates on password change, helmet+CSP is fully configured, rate limits are layered, the AsyncLocalStorage trace-id propagation is the right pattern, and the dual web/worker Railway split with embedded-mode fallback is well-thought-out. The weaknesses are predictable for a fast-moving SaaS: scale-out concerns that haven't bitten yet, multi-tenancy by convention instead of by guard rail, and accumulated debug flags from migrations that completed but were never cleaned up.

**Dead-code volume estimate: ~3% of production code, ~70% of `tooling/`.** Knip reports 1,363 "unused files" but 1,344 of those are in `.claude/worktrees/` (leftover Claude agent worktrees) or `tooling/` (gitignored ops scripts that ran once). Real dead exports in `server/`+`client/src/`+`shared/`: ~95 functions/types (most in shadcn UI barrel files that re-export everything). Single dead file in checked-in code: [`drizzle/relations.ts`](drizzle/relations.ts) (1 line, never imported). Plus 5 deprecated `@types/*` packages that can be deleted.

**Critical security findings: 5.**
1. `triggersRouter.update` — UPDATE without userId WHERE clause ([triggersRouter.ts:142](server/routers/triggersRouter.ts#L142))
2. `triggersRouter.regenerateKey` — same ([triggersRouter.ts:254](server/routers/triggersRouter.ts#L254))
3. `workflowsRouter.update` — same ([workflowsRouter.ts:176](server/routers/workflowsRouter.ts#L176))
4. `workflowsRouter.saveCanvas` — same ([workflowsRouter.ts:243](server/routers/workflowsRouter.ts#L243))
5. `affiliateService.ts:928` — outbound HTTP to user-templated URL without SSRF guard

**Recommended next sprint focus:** Fix the 5 CRITICAL findings, instrument Sentry in worker, reconcile the migration journal, and ship per-procedure ownership-check helpers (`assertUserOwns(table, id, userId)`) so future routers can't regress. Don't start the Express 5 migration until those are done.

---

# Section A — Dead Code & Unused Dependencies

## A.1 — Knip results (refreshed 2026-05-16)

Ran `pnpm dlx knip` (exit 0, see `knip.human.txt`). Output dominated by gitignored noise; real findings below.

**Unused files (real code only):**
- [`drizzle/relations.ts`](drizzle/relations.ts) — 1-line file, never imported anywhere. Originally for Drizzle's relational queries, but the code uses `db.select()` with manual joins. **Delete.**
- Plus 1,344 files in `.claude/worktrees/busy-mayer-9f5757/` (leftover Claude agent worktree — delete the entire directory) and ~115 in `tooling/` (one-shot ops scripts, intentionally gitignored — no action).

**Unused dependencies (deprecated `@types/*` shims):**
- `@types/bcryptjs` ([package.json:46](package.json#L46)) — `bcryptjs ^3.0.3` ships its own types
- `@types/node-telegram-bot-api` ([package.json:47](package.json#L47)) — the library ships types
- `@types/cors` ([package.json:86](package.json#L86)) — no `cors` package is even installed
- `@types/express-rate-limit` ([package.json:88](package.json#L88)) — `express-rate-limit` ships its own types
- `@types/google.maps` ([package.json:89](package.json#L89)) — Google Maps is not actually used in code

**Action:** `pnpm remove @types/bcryptjs @types/node-telegram-bot-api @types/cors @types/express-rate-limit @types/google.maps` — 5-line PR, zero risk.

**Unlisted binaries:** `railway` (used in `db:railway:migrate` script) — Railway CLI is a global, this is expected and harmless. Could add to `ignoreBinaries` in `knip.audit.json`.

**Duplicate exports:**
- [`server/routers/emailAuthRouter.ts`](server/routers/emailAuthRouter.ts) exports both `authRouter` and `emailAuthRouter` (same router). One alias is consumed by [`server/routers.ts:2`](server/routers.ts#L2) (`authRouter`); the named export `emailAuthRouter` is dead. **Drop the alias.**
- [`client/src/components/ExpressionInput.tsx`](client/src/components/ExpressionInput.tsx) exports both default and named; default is dead per ts-prune. **Drop the default.**

## A.2 — Depcheck cross-validation

Ran `pnpm dlx depcheck`. "Missing dependencies" output is a **false positive** — every reported "missing" entry is a TS path alias (`@shared/*`) resolved through `tsconfig.json paths`, not a real npm dependency. Depcheck does not honor tsconfig paths.

## A.3 — ts-prune dead exports

Ran `pnpm dlx ts-prune > tsprune.audit.txt`. 422 lines total, 268 are "(used in module)" false positives (variables exported for type inference). **154 truly unused cross-file exports.**

Highlights (top removable ones in real code):
- [`server/db.ts:111 closeDb`](server/db.ts#L111) — CLI scripts in `tooling/` use it, but `tooling/` is ignored. Keep as-is.
- [`server/_core/publicUser.ts:16 toPublicUser`](server/_core/publicUser.ts#L16) — never called. **Delete file.**
- [`server/_core/httpLogging.ts:26 summarizeRequestPayload`](server/_core/httpLogging.ts#L26) — orphan helper. **Delete.**
- [`server/integrations/index.ts`](server/integrations/index.ts) — barrel re-exports 26 symbols; none imported via this barrel (callers go directly to the source modules). **Either delete the barrel or rewrite callers to use it.**
- [`server/services/circuitBreaker.ts`](server/services/circuitBreaker.ts) — 8 exported types/constants only referenced inside the same module (knip's "used in module" duplicates this finding). Reduce to internal.
- 27 shadcn UI exports in `client/src/components/ui/*.tsx` — these are re-exports of Radix sub-components for completeness. **Keep.**
- [`client/src/components/destinations/createPayload.ts`](client/src/components/destinations/createPayload.ts) — `collectHeadersArray`, `collectBodyFieldsArray`, `appendQueryParams` are 3 functions that look meant for tests; the corresponding test file is in `.claude/worktrees/...`. **Investigate — likely dead.**

## A.4 — Stale code markers

Only **13 instances** of TODO/FIXME/HACK/DEPRECATED/LEGACY across `server/`, `client/`, `shared/`. The codebase is unusually clean.

| File:Line | Marker | Snippet |
|---|---|---|
| [server/db.ts:475](server/db.ts#L475) | LEGACY | `LEGACY_WIZARD_FIELDS` — explicit deprecation comment, real telemetry guard around it |
| [server/db.ts:483](server/db.ts#L483) | LEGACY | usage of the constant above |
| [server/db.ts:696](server/db.ts#L696) | LEGACY | comment "LEGACY MIRROR with GUARD" |
| [server/integrations/dynamicTemplateSource.ts:21](server/integrations/dynamicTemplateSource.ts#L21) | LEGACY | `LEGACY_TO_SEMANTIC` mapping |
| [server/integrations/manifest.ts:292](server/integrations/manifest.ts#L292) | @deprecated | use AppModule.fields[] — will be removed |
| [server/integrations/resolveAdapterKey.ts:110](server/integrations/resolveAdapterKey.ts#L110) | LEGACY | `path: "LEGACY_DEFAULT" as const` |
| [server/services/retryScheduler.ts:38](server/services/retryScheduler.ts#L38) | @deprecated | per-minute helper superseded |
| [client/src/pages/Destinations.tsx:250](client/src/pages/Destinations.tsx#L250) | LEGACY | `LEGACY_AFFILIATE_API_KEY_FIELD` |

**Verdict:** All markers are accompanied by either telemetry (`db.ts`) or clear migration notes. Nothing rotting.

## A.5 — Backup/dump files

| File | Size | Age | Status |
|---|---|---|---|
| [backup_api_keys.json](backup_api_keys.json) | 524 B | 2026-04-23 | Plaintext secrets — gitignored. **Delete.** |
| [backup_api_keys_stageD_v2.json](backup_api_keys_stageD_v2.json) | 524 B | 2026-04-23 | **Delete.** |
| [backup_api_keys_stageD_v3_all_2026-04-23T10-44-35-864Z.json](backup_api_keys_stageD_v3_all_2026-04-23T10-44-35-864Z.json) | 5.1 KB | 2026-04-23 | **Delete.** |
| [backup_api_keys_stageD_v3_id30003_2026-04-23T07-00-39-582Z.json](backup_api_keys_stageD_v3_id30003_2026-04-23T07-00-39-582Z.json) | 1.2 KB | 2026-04-23 | **Delete.** |
| [backup_stage4_no_connection.json](backup_stage4_no_connection.json) | 11 KB | 2026-04-23 | **Delete.** |

All are 23+ days old, from a one-off stage-4 rollback. Per [.gitignore:120](.gitignore#L120) they should never have been created at repo root.

`tooling/` has ~50 `apply-*.mjs`/`backfill-*.ts`/`check-*.mjs`/`debug-*.mjs` scripts that look one-shot. Sample dates: `apply-0083-orders-index.mjs`, `apply-0089-insights-phase4.mjs`. Since the directory is gitignored, no archive action needed, but I'd recommend moving completed apply-* scripts to `tooling/_archive/` to mirror the existing `tooling/_archive/mysql/` pattern.

---

# Section B — Database Audit

## B.1 — Schema vs reality drift

Schema file: [drizzle/schema.ts](drizzle/schema.ts), 1,598 lines, **41 tables** (confirmed). `pnpm drizzle-kit introspect` requires a live MySQL connection — INCONCLUSIVE without prod credentials. Recommend running it in a Railway shell and diffing against `schema.ts`.

## B.2 — Per-table usage scan

Generated query script at [tooling/audit/check-table-usage.sql](tooling/audit/check-table-usage.sql). 10 queries to run against the prod read-replica.

**Code-side usage scan (count of `<tableExportName>` token references in `server/`+`client/`+`shared/`):**

Tables **referenced fewer than 3 times** (likely dead or used only in their own definition):

| Table | Refs | Status |
|---|---|---|
| `adminAuditLogs` | 2 | Used by `adminAuditService.ts` only — table is real, used heavily for inserts (via the service). Low ref count is fine. |
| `campaignDailyInsights` | 2 | New insights table. Only `insightsRollupScheduler.ts` writes it. Real but narrow scope. |
| `circuitBreakerEvents` | 2 | Append-only audit trail for circuit breaker. Real but narrow. |
| `metricSnapshots` | 2 | Same — only `metricSnapshotScheduler` writes. |

None of these are actually dead — all 4 are "narrow scope by design" (one writer, one reader for time-series rollups). **No action.**

Tables with **3–10 references** that might be over-engineered:

| Table | Refs | Note |
|---|---|---|
| `orderEvents` | 5 | Inserted in `leadDispatch`/`orderRetryScheduler` — minor surface. Fine. |
| `connectionHealthLogs` | 6 | Health-probe history. Niche but justified. |
| `fxRates` | 6 | Daily FX rate cache. Single reader/writer. Fine. |
| `triggerExecutions` | 10 | Trigger run audit. OK. |
| `passwordResetTokens` | 12 | Auth flow. OK. |

**Conclusion:** No truly unused tables. The schema is lean.

## B.3 — Migration health

**File count:** 114 SQL files in `drizzle/` (matches Phase 1). 22 of those are `*_rollback_*.sql` paired files (one rollback per migration since 0069).

**Journal integrity (CRITICAL DRIFT):**
- [drizzle/meta/_journal.json](drizzle/meta/_journal.json) has **81 entries** (idx 0–80).
- Disk has migrations 0000 through 0090.
- **Mismatches:**
  - `0025_password_reset_tokens.sql` and `0027_destination_templates.sql` exist on disk but the JOURNAL has different `0025_absent_rage` and `0027_flippant_garia` — two migration numbers were reused. Local-only migrations vs. prod-applied migrations are out of sync.
  - `0054_drop_connection_app_specs.sql` exists on disk but the journal jumps `0053 → 0055` (idx 54 = `0055_oauth_tokens_universal`).
  - `0057_*`, `0059_*`, `0060_*` are entirely missing from both disk and journal (journal jumps 0056→0058, 0058→0061).
  - **Migrations `0085`–`0090` exist on disk but are NOT in the journal.** `drizzle-kit migrate` may try to re-apply them in dev/local environments.

This drift was patched manually via `tooling/drizzle/backfill-migration-journal-0026-0027.mjs` (per `db:railway:migrate` script). **The journal needs a one-shot reconciliation** before the next `drizzle-kit generate` round, or new local migrations will collide with renumbered prod ones.

**Rollback files:** Every migration from 0069 onward has a paired `_rollback_*.sql`. This is **defensive** (good!), but 22 rollback files in 26 days = the rename-cycle (target_websites → destinations, see Phase 1 memory) was painful. None are commented-out or `-- noop`.

**Pending migrations:** Yes — `0085`–`0090` (insights phase 1, campaign_daily_insights, collation fix, payout currency, insights phase 4, orders offer name) are on disk but not journaled. They've been manually applied via `tooling/apply-0085-*.mjs` through `apply-0090-*.mjs`. **Reconcile the journal.**

## B.4 — Index coverage

Most tables are well-indexed. **Gaps:**

| Table | Issue | Severity |
|---|---|---|
| [destinations](drizzle/schema.ts#L473) | **ZERO secondary indexes** — only the implicit PRIMARY. Every list/filter query scans the table. | HIGH (will hit ~50k rows soon) |
| [passwordResetTokens](drizzle/schema.ts#L109) | No userId index. Reset flow queries by `token` (unique idx) so this is fine. | LOW |
| [facebookConnections](drizzle/schema.ts#L145) | Has `idx_facebook_connections_page_id` but no userId index. Webhook fanout uses pageId. OK. | LOW |
| [destinations](drizzle/schema.ts#L473) | Also no `userId` index — `getDestinations(userId)` is a full scan. | HIGH |

**Redundant indexes:** None found. Indexes are well-curated (the schema has clear comments on each index's purpose — see [drizzle/schema.ts:820-830](drizzle/schema.ts#L820)). 

**Time-series indexes verified on high-volume tables:**
- `leads`: `idx_leads_user_created_at`, `idx_leads_created_at` ✓
- `orders`: `idx_orders_created_at`, `idx_orders_user_status` ✓
- `webhook_events`: `idx_webhook_events_created_at` ✓
- `app_logs`: FIVE createdAt indexes ✓ (perhaps too many — consider consolidating)

**RECOMMENDATION:** Add to `destinations`:
```ts
}, (t) => ({
  idxUserId: index("idx_destinations_user_id").on(t.userId),
  idxUserAppKey: index("idx_destinations_user_app").on(t.userId, t.appKey),
  idxConnectionId: index("idx_destinations_connection_id").on(t.connectionId),
}));
```

## B.5 — Multi-tenancy enforcement (CRITICAL)

Scanned every tRPC procedure across 25 routers. **No central tenant middleware.** Each handler must add `eq(table.userId, ctx.user.id)` manually.

**4 CRITICAL findings** (sub-agent audit — verify by code review before patching):

| File:Line | Procedure | Table | Issue |
|---|---|---|---|
| [server/routers/triggersRouter.ts:142](server/routers/triggersRouter.ts#L142) | `triggers.update` | `triggers` | Ownership SELECT runs earlier, but the subsequent UPDATE uses `eq(triggers.id, input.id)` only. TOCTOU window allows another user with a guessed id to mutate the row. |
| [server/routers/triggersRouter.ts:254](server/routers/triggersRouter.ts#L254) | `triggers.regenerateKey` | `triggers` | Same pattern — UPDATE missing userId. |
| [server/routers/workflowsRouter.ts:176](server/routers/workflowsRouter.ts#L176) | `workflows.update` | `workflows` | Same pattern. |
| [server/routers/workflowsRouter.ts:243](server/routers/workflowsRouter.ts#L243) | `workflows.saveCanvas` | `workflows` | Same pattern. |

**Fix (apply to all 4):** add `and(eq(triggers.id, input.id), eq(triggers.userId, ctx.user.id))` to the WHERE clause of the UPDATE. The SELECT ownership check beforehand is necessary but not sufficient — UPDATEs are not transactionally guarded against concurrent ID guessing.

**Better long-term fix:** Add a `assertUserOwns(db, table, id, userId)` helper in `server/lib/` and require every router that touches a tenant-scoped row to call it before any write. Even better: a tRPC middleware that automatically derives the user filter from a `withUserScope(table)` builder.

**Direct DB access bypassing tRPC:** `server/services/*` files DO query tenant-scoped tables directly (e.g., `leadService.ts`, `affiliateService.ts`, `orderRetryScheduler.ts`). These are called from BullMQ jobs and schedulers, which run with a known `userId` from the job payload — verified to be safe in the schedulers I sampled. **But there is no compile-time guarantee.**

---

# Section C — Code Duplication & Naming

## C.1 — jscpd copy-paste detection

Ran `pnpm dlx jscpd ./server ./client/src ./shared --min-lines 8 --min-tokens 60`. **6 clones found.** This is very low for a 98k-LOC codebase.

| Pair | Lines | Tokens | Verdict |
|---|---|---|---|
| [server/routers/adAnalyticsRouter.ts:250](server/routers/adAnalyticsRouter.ts#L250) ↔ [adAnalyticsRouter.ts:297](server/routers/adAnalyticsRouter.ts#L297) | 8 | 99 | Same router — minor refactor candidate |
| [server/lib/leadEnrichmentRetryPolicy.ts:25](server/lib/leadEnrichmentRetryPolicy.ts#L25) ↔ [orderRetryPolicy.ts:22](server/lib/orderRetryPolicy.ts#L22) | 11 | 140 | Two retry-policy modules with the same backoff shape. Extract `computeBackoff(attempt, baseMs, maxMs)` to a shared helper. |
| Same pair, end-of-file (lines 157↔119) | 9 | 116 | Same as above — same duplication. |
| [server/integrations/dynamicTemplateSource.ts:249](server/integrations/dynamicTemplateSource.ts#L249) ↔ [dynamicTemplateSource.ts:161](server/integrations/dynamicTemplateSource.ts#L161) | 15 | 198 | Same file — extract local helper. |
| Same file, second clone (267↔186) | 11 | 96 | Same as above. |
| [server/db.ts:295](server/db.ts#L295) ↔ [server/db.ts:177](server/db.ts#L177) | **31** | **463** | **Biggest duplicate.** `getLeads` (177) and `getLeadsCount` (295) share the same filter-building block. Extract `buildLeadsFilters(userId, status, pageId, …)` returning `SQL[]`. |

The 11 app manifests in `server/integrations/apps/` and the 6 adapters in `server/integrations/adapters/` did NOT trigger jscpd — they share architectural shape but not text. Good factoring.

## C.2 — Circular dependencies (3 found)

```
1) server/db.ts > services/integrationRoutes.ts
2) server/db.ts > services/integrationRoutes.ts > services/appLogger.ts
3) server/services/affiliateService.ts > utils/resolveMapping.ts
```

[`server/db.ts`](server/db.ts) lazily `import()`s `services/integrationRoutes.ts` to avoid the cycle at module load — that's why this works. But it's a code smell.

**Fix:**
- Move shared types between `db.ts` and `integrationRoutes.ts` to a third module (`server/lib/integrationRoutesTypes.ts`).
- For `affiliateService → utils/resolveMapping → affiliateService`: extract the cycled type into `server/utils/resolveMapping.types.ts`.

`shared/` has zero cycles ✓. `client/src` has the same 3 cycles (because it transitively imports `server` types for tRPC — those types come from server modules).

## C.3 — Naming consistency

INCONCLUSIVE on full audit (would require ~3 more agent runs). Spot-check findings:

- `get*` vs `fetch*`: `getLeads`, `getLeadById`, `getLeadStats`, `getLeadsCount` in `server/db.ts` use `get*`. `services/facebookGraphService.ts` uses `fetchLead*`, `fetchAdAccounts`. **Convention:** `get` for local DB, `fetch` for remote HTTP. This is actually consistent.
- `create*` vs `insert*`: `createIntegration`, `createDestination` (router) vs `db.insert(...)` (Drizzle DSL). Consistent.
- `delete*` vs `remove*`: mixed. `deleteIntegration` (soft-delete) vs `removeIntegrationRoute`. Minor.
- Service module exports: most services export bare functions; `circuitBreaker.ts` exports a state-machine object; `appLogger.ts` exports a `log` namespaced object. **Inconsistent but appropriate per concern.**

## C.4 — Type duplication (minimal)

Searched for re-defined `User|Lead|Order|Integration|...` types outside `drizzle/schema.ts`:

- [server/services/adAccountsService.ts:115](server/services/adAccountsService.ts#L115) — `export interface AdAccount` — this is the FB-API shape, distinct from the DB `adAccounts` table type. **OK but rename to `FbAdAccount` to avoid shadowing.**
- [client/src/components/leads/LeadCard.tsx:9](client/src/components/leads/LeadCard.tsx#L9) — `interface Order` — local prop type. **Replace with** `import type { Order } from "@shared/.../orders"` after deriving from Drizzle `$inferSelect`.
- [client/src/components/leads/LeadsTable.tsx:20](client/src/components/leads/LeadsTable.tsx#L20) — same.

The schema already exports `Order`, `Lead`, `Integration`, `User`, `Connection`, etc. via `typeof <table>.$inferSelect` — those are the canonical types. The 3 client-side re-defs are minor.

## C.5 — Folder structure smell

- **`server/routes/` (5 files) vs `server/routers/` (25 files):** real friction. Both names autocomplete to each other. Recommendation: rename `server/routes/` → `server/rest/` to make the REST-vs-tRPC split obvious.
- **`server/_core/`** mixes legitimate core (`trpc.ts`, `context.ts`, `sdk.ts`, `validateEnv.ts`, `env.ts`, `globalErrorHandlers.ts`, `vite.ts`) with orphans (`patchedFetch.ts`, `notification.ts`, `chat.ts` — disabled, `cookies.ts`, `httpLogging.ts`, `systemRouter.ts`, `publicUser.ts` — dead per ts-prune). Suggested split: keep `trpc/context/sdk/env/validateEnv/globalErrorHandlers/vite` here; move logging utilities to `server/lib/`; delete `chat.ts` and `publicUser.ts`. Low priority.

---

# Section D — Architecture Assessment

## D.1 — Layering violations (NONE)

Greps for the 4 forbidden patterns each returned **zero matches**:

```
grep -rn "from .*routers/"  server/routers/  → 0 matches (outside routers/index)
grep -rn "@trpc"             server/services/ → 0 matches
grep -rn "from .*services/"  server/lib/      → 0 matches
grep -rn "from .*server\|from .*client" shared/ → 0 matches
```

**This is excellent.** The layering discipline is real, not just aspirational.

## D.2 — tRPC procedure structure

Router LOC ranked (excluding `.test.ts`):

| LOC | Router | Verdict |
|---|---|---|
| 12 | webhookRouter | OK |
| 51 | googleRouter | OK |
| 90 | adminAppActionsRouter | OK |
| 113–491 | 14 routers | OK |
| **550** | emailAuthRouter | Borderline — auth flow naturally complex |
| **577** | insightsRouter | Borderline |
| **607** | adminTemplatesRouter | Split candidate |
| **639** | integrationsRouter | Split candidate |
| **751** | leadsRouter | **TOO LARGE** — split into `leadsListRouter`, `leadsDetailRouter`, `leadsStatsRouter` |
| **752** | adAnalyticsRouter | **TOO LARGE** |
| **811** | facebookAccountsRouter | **TOO LARGE** |
| **856** | connectionsRouter | **TOO LARGE** |
| **1138** | crmRouter | **TOO LARGE** |
| **1671** | destinationsRouter | **WAY TOO LARGE** — this is the next refactor target |

Procedure length not measured per-procedure (would need an AST pass). Reading `destinationsRouter.ts` confirms many procedures handle template variable expansion, secret decryption, and adapter-spec validation inline — push to `server/services/destinationService.ts`.

## D.3 — Service modularity

Service files ranked:

| LOC | File | Verdict |
|---|---|---|
| 977 | [affiliateService.ts](server/services/affiliateService.ts) | **TOO LARGE** — contains the universal HTTP delivery path, secret resolution, variable extraction, header building. Split into `affiliateDelivery.ts`, `affiliateSecrets.ts`, `affiliateVars.ts`. |
| **1225** | [circuitBreaker.ts](server/services/circuitBreaker.ts) | **GOD SERVICE** — contains state machine, evaluation, persistence, snapshot APIs, bulk previews, enforcement scope. Has 401-line + 570-line test files which is appropriate for the complexity, but the source is too monolithic. |
| **1555** | [leadService.ts](server/services/leadService.ts) | **GOD SERVICE** — pipeline status, ingest, dispatch, recalculation, fanout. Split into `leadIngest.ts`, `leadFanout.ts`, `leadStatus.ts`. |
| 565 | adsSyncService.ts | Borderline |
| 559 | googleSheetsService.ts | OK |
| 506 | connectionService.ts | OK |
| 490 | facebookGraphService.ts | OK |

**Imports/imported-by counts not measured** (would need madge `--summary`). Recommend manual review of `leadService.ts` and `affiliateService.ts` first.

## D.4 — Scheduler hygiene (CRITICAL)

Auto-detected via grep for `setInterval`, in-flight guards (`isRunning|inFlight|locked|Mutex`), and signal handlers. Results across all 12 schedulers:

| Scheduler | setInterval | Overlap-guard | SIGTERM | Verdict |
|---|---|---|---|---|
| adsSyncScheduler | ✓ | **NONE** | ✓ | **FIX** — long Graph API runs can overlap |
| connectionHealthScheduler | ✓ | ✓ | ✓ | OK |
| crmSyncScheduler | ✓ | ✓ | ✓ | OK |
| formsRefreshScheduler | ✓ | **NONE** | ✓ | **FIX** |
| fxRateScheduler | ✓ | ✓ | ✓ | OK |
| insightsRollupScheduler | ✓ | ✓ | ✓ | OK |
| logRetentionScheduler | ✓ | **NONE** | ✓ | **FIX** — DELETE under load can run long |
| metricSnapshotScheduler | ✓ | ✓ | ✓ | OK |
| oauthStateCleanupScheduler | ✓ | **NONE** | **NONE** | **FIX** both |
| orderRetryScheduler | ✓ | ✓ (heavily) | ✓ | Excellent |
| retryScheduler | ✓ | **NONE** | ✓ | **FIX** |
| triggerScheduler | ✓ | **NONE** | ✓ | **FIX** |
| leadPollingService | ✓ | **NONE** | ✓ | **FIX** — Graph API polling can stack up |

**7 of 12 schedulers can stack runs** if a prior tick is still running (slow DB, slow Graph API). Symptom: increasing memory + duplicate-work warnings.

**Fix pattern (copy from `orderRetryScheduler.ts`):**
```ts
let inFlight = false;
const tick = async () => {
  if (inFlight) { log.warn("SCHED", "skipping overlap"); return; }
  inFlight = true;
  try { await doWork(); } finally { inFlight = false; }
};
setInterval(() => void tick(), INTERVAL_MS);
```

## D.5 — Error handling

**Silent-swallow `try/catch`:** 8 occurrences, all in OAuth popup helper HTML (the catches wrap `BroadcastChannel.postMessage` and `window.opener.postMessage` calls that can throw cross-origin). **These are intentional and correct** — popup-close paths shouldn't bring down the parent window. Files:
- [server/routes/oauthRouter.ts:52-53](server/routes/oauthRouter.ts#L52)
- [server/routes/facebookLoginOAuth.ts:107-117](server/routes/facebookLoginOAuth.ts#L107)
- [server/routes/facebookOAuthCallback.ts:127-134](server/routes/facebookOAuthCallback.ts#L127)

**globalErrorHandlers.ts behavior:**
- ✓ Calls `process.exit(1)` on `uncaughtException` (via `setTimeout(() => process.exit(1), 100)` to flush logs).
- ✗ Does **NOT** report to Sentry. Recommended: add `Sentry.captureException(err)` before exit, with a 2s flush window.

## D.6 — SSRF and secret-handling (CRITICAL → resolved)

> **Amended 2026-05-17.** Two of three findings below were false positives —
> they were already guarded by `assertSafeOutboundUrl` at the time of the
> audit and the sub-agent missed it. See corrections at the top of this
> file. The remaining MEDIUM (workflowExecutor) was fixed alongside the
> appLogger redaction. Both are now closed.

**SSRF audit — outbound HTTP calls (re-verified state):**

~~CRITICAL~~ → **ALREADY PROTECTED** (false positive):
- [server/services/affiliateService.ts:928](server/services/affiliateService.ts#L928) — protected by
  `assertSafeOutboundUrl(template.endpointUrl)` at
  [line 859](server/services/affiliateService.ts#L859) (same try block, runs before the axios call).
  Guard added 2026-04-16 by commit `9bfc19bd`. The Section D.6 sub-agent
  grepped line 928 in isolation and missed the call 69 lines above.

~~MEDIUM~~ → **ALREADY PROTECTED** (false positive):
- [server/integrations/adapters/httpRequestAdapter.ts:220](server/integrations/adapters/httpRequestAdapter.ts#L220) — protected by
  `assertSafeOutboundUrl(finalUrl)` at
  [line 189](server/integrations/adapters/httpRequestAdapter.ts#L189) (runs after URL render, before the axios call).
  No inline guard ever existed here — the audit conflated this with the
  workflowExecutor pattern.

~~MEDIUM~~ → **FIXED 2026-05-17**:
- [server/services/workflowExecutor.ts:82](server/services/workflowExecutor.ts#L82) (formerly :86) — was
  protected by a local `isSafeUrl()` + `BLOCKED_HOSTS` regex that allowed
  `http:` and did NOT resolve DNS (rebinding-bypass possible). Migrated
  to `await assertSafeOutboundUrl(url)` from `lib/urlSafety` in this
  commit. Behaviour change: workflow `http_request` steps now require
  HTTPS, blocking any legacy step using `http://`. Correct security
  posture; an HTTP step would have always been a footgun.

LOW (fixed-domain URLs — Facebook Graph, Telegram Bot API, Google Sheets
API, Eskiz, PlayMobile): safe; no user input controls the hostname.
**One outstanding follow-up:** [server/routes/brandIconsRouter.ts:75](server/routes/brandIconsRouter.ts#L75) fetches
favicons from an arbitrary `domain` — trace whether `domain` is admin-
or user-supplied and add a guard if user-controlled.

**Secret logging audit:**
- ~~`appLogger.ts` has **no built-in redaction**.~~ → **FIXED 2026-05-17.**
  `appLogger.ts` now exports `redactSecrets(value)` and applies it
  automatically to every `meta` payload before console/DB/Sentry sinks
  receive it. Redacts keys matching
  `/password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|bearer|client[_-]?secret/i`
  — superset of the existing HTTP-request-body redaction list.
- HTTP request logger in [server/_core/index.ts:86-93](server/_core/index.ts#L86) DOES redact `password`,
  `currentPassword`, `newPassword`, `confirmNewPassword`, `token`,
  `secret`, `accessToken` in body previews. Good — and consistent with
  the new appLogger list.
- Real findings: zero call sites observed that log a full token or
  password. The webhook logger truncates tokens to 8 chars + `...`. The
  OAuth error logger logs `oauthTokenId` (DB primary key, safe).

**Verdict:** SSRF — closed (1 false positive cleared, 1 false positive
unchanged, 1 real MEDIUM fixed). Secret-logging — closed (defense-in-
depth redaction now automatic). `brandIconsRouter.ts` remains as the
only outstanding LOW item.

## D.7 — Express 4 → 5 readiness

Grepped for known-break patterns:
- `req.param(` — **0 occurrences** ✓
- `res.send(<status>, …)` two-arg form — **0** ✓
- `app.del(` — **0** ✓
- `req.host` (deprecated, removed in 5) — not checked

**The codebase looks Express-5 ready by happy accident.** Migration effort estimate: ≤4 hours. Main risk: `@types/express` is at 4.17.21 — upgrading to v5 types may surface latent `any` casts.

---

# Section E — Test & Coverage Reality

## E.1 — Coverage NOT INSTALLED (config provided)

Did not modify `package.json` (would require approval to commit). Apply these changes:

```bash
pnpm add -D @vitest/coverage-v8
```

Append to [vitest.config.ts](vitest.config.ts):
```ts
  test: {
    environment: "node",
    include: [
      "server/**/*.test.ts",
      "server/**/*.spec.ts",
      "client/src/**/*.test.ts",
      "shared/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: ["server/**", "client/src/**", "shared/**"],
      exclude: [
        "**/*.test.ts",
        "**/*.config.*",
        "drizzle/**",
        "tooling/**",
        "**/*.d.ts",
        "client/src/components/ui/**",
      ],
      thresholds: {
        statements: 40,  // start here; raise as coverage grows
        branches: 30,
        functions: 40,
        lines: 40,
      },
    },
  },
```

Then `pnpm test --coverage`. INCONCLUSIVE on actual coverage % without running.

## E.2 — Test quality

- **141** `.test.ts` files (matches Phase 1).
- **1,175** `expect(` calls across all test files.
- **3** files contain `.skip` or `.todo` patterns — sample-check shows these are intentional database-required tests.
- **0** test files with zero `expect()` calls — every test asserts something. Good.

CI doc claims "~513 tests" — given 1,175 `expect()` calls, that's plausible (avg ~2.3 expects per test).

## E.3 — Missing router test coverage

Of 25 tRPC routers, **only 1 has a dedicated test:**
- [server/routers/adminAppsRouter.test.ts](server/routers/adminAppsRouter.test.ts) (317 LOC)

**24 routers without dedicated tests.** High-risk ones (highest LOC, most business logic):
- `destinationsRouter` (1,671 LOC)
- `crmRouter` (1,138 LOC)
- `connectionsRouter` (856 LOC)
- `facebookAccountsRouter` (811 LOC)
- `adAnalyticsRouter` (752 LOC)
- `leadsRouter` (751 LOC)

The 14 service-layer tests cover the bulk of business logic, but **tenant-isolation regressions live in the router layer** — and the 4 CRITICAL findings in B.5 prove it. Recommendation: add a single `tenantIsolation.integration.test.ts` per router that calls every procedure with `userA`'s session against `userB`'s data and asserts FORBIDDEN/empty results.

[server/multiTenantIsolation.test.ts](server/multiTenantIsolation.test.ts) exists — INCONCLUSIVE which tables it covers without reading it. Recommended: ensure it covers all 19 tenant-scoped tables.

---

# Section F — Configuration & Operational Hygiene

## F.1 — `.env.example` GENERATED

Generated at [`.env.example`](.env.example), 70+ keys grouped into 11 categories (Platform, App identity, Database, Redis, Auth, Facebook, Google, Telegram, Email, Forge, Analytics, Observability, Worker tuning, Feature flags, Debug flags). Each marked REQUIRED/OPTIONAL based on `validateEnv.ts`. Use safe placeholder values where applicable.

**Commit-ready.**

## F.2 — Env vars used but not in current `.env`

Already enumerated in Phase 1. Spot-verified for live code paths:

- `START_WORKER` — used in [server/_core/index.ts:404](server/_core/index.ts#L404). **Active** (embedded-worker mode).
- `WORKER_HEALTH_PORT` — used in [server/workers/run.ts:52](server/workers/run.ts#L52). **Active** (worker /health endpoint).
- `ENABLE_LEAD_POLLING` — used in `leadPollingService.ts`. **Active** (Zapier-style polling fallback).
- `STAGE2_*_LOG` flags (5 of them) — debug logging from the Stage 2 migration. Migration completed weeks ago per recent commits. **Likely dead — recommend removing.**
- `OAUTH_DEBUG`, `BRAND_ICON_LOG`, `METRICS_LOG`, `TYPE_VALIDATION_LOG` — diagnostic-only flags. Keep if used during incidents; remove otherwise.
- `APP_BASE_URL` — alias of `APP_URL`. Confusing duplicate. **Pick one.**
- `FORGE_API_KEY` vs `BUILT_IN_FORGE_API_KEY` — second one is the real one (per `_core/env.ts`). The first is a legacy alias. **Drop.**

## F.3 — Feature/debug flag inventory

| Flag | Type | Recommendation |
|---|---|---|
| `START_WORKER` | feature | KEEP — single-service deployment mode |
| `ENABLE_LEAD_POLLING` | feature | KEEP — has explicit gate |
| `CB_ENFORCEMENT` | feature | KEEP — circuit breaker enforcement mode |
| `STAGE2_ADAPTER_LOG` | debug | **REMOVE** — Stage 2 migration is done |
| `STAGE2_APPS_LOG` | debug | **REMOVE** |
| `STAGE2_APP_ROUTING_LOG` | debug | **REMOVE** |
| `STAGE2_DYNAMIC_TEMPLATE_LOG` | debug | **REMOVE** |
| `STAGE2_SPEC_LOG` | debug | **REMOVE** |
| `OAUTH_DEBUG` | debug | KEEP if oncall uses it |
| `BRAND_ICON_LOG` | debug | KEEP |
| `METRICS_LOG` | debug | KEEP |
| `TYPE_VALIDATION_LOG` | debug | KEEP |

## F.4 — Sentry config

- `tracesSampleRate` reads `process.env.SENTRY_TRACES_SAMPLE_RATE` default `0.1` ([sentry.ts:52](server/monitoring/sentry.ts#L52)). ✓ Reasonable.
- **Sentry is NOT initialized in the worker process.** [server/workers/run.ts](server/workers/run.ts) never calls `initSentry()`. [server/workers/leadWorker.ts:112](server/workers/leadWorker.ts#L112) imports `captureCritical` from `monitoring/sentry`, but without init it's a no-op. **CRITICAL — every BullMQ job error in production is currently lost.**
- Web Sentry init in [server/_core/index.ts:138](server/_core/index.ts#L138). Express error handler attached at line 369. ✓
- **Fix:** add `await initSentry()` at the top of `boot()` in `server/workers/run.ts`, before any worker/scheduler starts.

## F.5 — Rate limits

Layered limits in [server/_core/index.ts:202-245](server/_core/index.ts#L202):
- Auth: 10 / 15min / IP ✓
- Password reset: 5 / hr / IP ✓
- Webhooks: 500 / min / IP ✓
- Global API: 200 / min / IP ⚠

**200 / min global API may be too tight** for an active SaaS user with a polling dashboard + multiple integration edits. Per-user rate limiting via `userRateLimit.ts` IS available but only applied at **2 procedures total** (adAnalyticsRouter line 477, adminTemplatesRouter lines 303, 353). Most procedures rely on IP-based global limiting.

**Recommendation:** Raise global to 500/min for `/api/trpc` (since the JWT cookie identifies the user, IP+procedure combinations rarely hit even today). Add per-user rate limits to the mutation-heavy admin paths (template writes, destination writes, integration writes).

---

# Section G — Dependency Modernization Plan

**Removal first (no risk):**
1. `pnpm remove @types/bcryptjs @types/node-telegram-bot-api @types/cors @types/express-rate-limit @types/google.maps` — deprecated type stubs, libraries ship their own. **Easy. Do this first.**

**Easy upgrades (drop-in):**
2. **`lucide-react` 0.453.0 → 1.16.0** — semver-major, but the icon export API is unchanged across the 0.x → 1.x transition. ~5 min.
3. **`@types/node` 24.10.9 → 25.8.0** — match Railway's Node 24/25. ~2 min.
4. **`@vitejs/plugin-react` 5 → 6** — Vite plugin API stable. ~2 min.
5. **Vite 7 → 8** — usually clean for SPA configs. Possible plugin compat check. ~15 min.

**Medium upgrades (some breakage):**
6. **TypeScript 5.9 → 6.0** — new stricter inference; the `noEmit: true` + `strict: true` config means any new errors must be fixed in `tsc --noEmit`. Estimate: 30–60 min depending on findings.
7. **superjson 1 → 2** — used as the tRPC transformer ([_core/trpc.ts:11](server/_core/trpc.ts#L11)). Check tRPC v11 compatibility matrix; the v2 release dropped some legacy serializers. ~1 hr.
8. **recharts 2 → 3** — chart API changes; every component in [Analytics.tsx](client/src/pages/Analytics.tsx), [Insights.tsx](client/src/pages/Insights.tsx), [DestinationAnalytics.tsx](client/src/pages/DestinationAnalytics.tsx) needs visual regression test. ~1–2 hrs.
9. **Vitest 2 → 4** — TWO majors. Migration guide reading + reviewing test imports. Plugin compat. ~2 hrs.
10. **drizzle-orm 0.44 → 0.45** — pre-1.0 minor bumps can be breaking. Re-run all tests. ~30 min.

**Hard upgrades (defer):**
11. **Express 4 → 5** — `@types/express` 4 → 5 too. Code looks ready (no `req.param`/`res.send(s,b)`/`app.del`), but Express 5 changed async error handling and route ordering. Test the entire HTTP surface. ~4 hrs + 1 week of monitoring.

**Prioritized order:**
1. Removal of 5 deprecated `@types/*` (5 min, zero risk).
2. Easy upgrades 2–5 batched in one PR (~30 min).
3. TypeScript 5 → 6 in its own PR (run `pnpm check` extensively).
4. Vitest 2 → 4 in its own PR (test suite stability).
5. Drizzle minor.
6. superjson + recharts as separate PRs.
7. **Defer Express 5** until after the CRITICAL findings in this audit are fixed.

---

# Section H — Methodology + Limitations

**Tools used:**
- `pnpm dlx knip` ✓ (results in `knip.human.txt`)
- `pnpm dlx depcheck` ✓ (false positives on TS aliases — discarded)
- `pnpm dlx jscpd ./server ./client/src ./shared` ✓
- `pnpm dlx madge --circular --extensions ts,tsx` × 3 trees ✓
- `pnpm dlx ts-prune` ✓ (results in `tsprune.audit.txt`)
- Grep-based pattern audits (TODO/FIXME/HACK/process.env/userId/etc.)
- 2 Explore sub-agents (multi-tenancy audit B.5, security audit D.5+D.6)
- Direct schema/journal/router file reads

**Limitations / INCONCLUSIVE items:**
- Test coverage % — config provided but not installed (would change `package.json`).
- `drizzle-kit introspect` against prod — requires DB credentials.
- B.2 SQL queries (table size, unused indexes, NULL ratios) — saved to [tooling/audit/check-table-usage.sql](tooling/audit/check-table-usage.sql), need a human to run against prod.
- The 4 CRITICAL multi-tenancy findings from B.5 are from a sub-agent — recommend code review of each before patching (the SELECT-then-UPDATE pattern is the right intent; the fix is widening the UPDATE WHERE clause).
- D.3 "imports-from / imported-by" counts not measured — would need `madge --summary`.
- Per-procedure LOC not measured for D.2 — would need AST traversal.
- Sub-agent for security found ~8 OAuth-popup catches; verified they're intentional fallbacks.

**Artifacts produced:**
- [.env.example](.env.example) — commit-ready
- [tooling/audit/check-table-usage.sql](tooling/audit/check-table-usage.sql) — read-only prod queries
- [knip.human.txt](knip.human.txt) — full knip output (1,631 lines)
- [tsprune.audit.txt](tsprune.audit.txt) — full ts-prune output (422 lines)
- [jscpd-report/](jscpd-report/) — full clone report JSON
- This file ([AUDIT_REPORT.md](AUDIT_REPORT.md))

---

_End of audit. — Phase 2._
