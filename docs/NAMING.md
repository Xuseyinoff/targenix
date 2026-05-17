# Naming and module conventions

This doc captures the patterns the codebase already follows, so new code doesn't have to grep-and-guess. Conventions are described from real usage in `server/` and `client/src/`, not invented from a style guide. Where the codebase is inconsistent, the inconsistency is named so you know what to follow in new code.

If you're about to add a procedure, helper, or service module, skim the relevant section before naming it.

---

## 1. Function name prefixes

Most data access lives inside tRPC procedure handlers (anonymous arrows in `server/routers/*.ts`), not as standalone exports. The standalone-helper counts below are smaller than they look because the same verbs are also used at the tRPC layer.

### `get*` — local DB or cache reads

Used for reading from your own database, in-memory cache, or AsyncLocalStorage context. ~54 standalone exports across 27 files; far more at the tRPC layer.

```ts
// server/db.ts
export async function getLeads(userId: number, ...) { ... }
export async function getLeadById(id: number, userId: number) { ... }
export async function getLeadStats(userId: number) { ... }

// tRPC examples — most CRUD reads live here, not as standalone functions
// server/routers/leadsRouter.ts
getById: protectedProcedure...
getDetail: protectedProcedure...
getTimeSeries: protectedProcedure...
```

### `fetch*` — remote HTTP or external API calls

Used when the data crosses a network boundary you don't own (Facebook Graph, Google Sheets API, third-party CRMs). ~7 standalone exports.

```ts
// server/services/facebookService.ts
export async function fetchLeadData(leadId: string, accessToken: string) { ... }

// server/services/adAccountsService.ts
export async function fetchAdAccounts(...) { ... }

// server/services/fxRateService.ts
export async function fetchUsdToUzs(...) { ... }
```

The split matters: `get` should never make a network call to a third party. If you're writing a function that hits Facebook Graph, use `fetch`.

### `list*` — pluralized reads, both DB and remote

Used both for DB list queries and for plural reads of remote resources. ~13 standalone exports plus heavy use at the tRPC layer.

```ts
// server/integrations/listAppsSafe.ts
export async function listAppsSafe(db: DbClient) { ... }

// tRPC — list is the canonical name for "show me all of mine"
// server/routers/destinationsRouter.ts
list: protectedProcedure.query(...)
// server/routers/connectionsRouter.ts
list: protectedProcedure...
listAppKeys: protectedProcedure...
listUsage: protectedProcedure...
// server/routers/telegramRouter.ts
listDeliveryChats: protectedProcedure...
listPendingChats: protectedProcedure...
```

`get` returns one row. `list` returns many. Don't write `getDestinations` for a list — use `list` (at the tRPC layer) or `listDestinations` (at the service layer).

### `create*` — DB insert with business logic

Used at the tRPC mutation layer almost exclusively. At the service layer it's rare (~7 standalone exports total). Bare `db.insert(...)` calls inside a router are not wrapped in a `create*` helper unless the logic is reused.

```ts
// server/routers/destinationsRouter.ts
create: protectedProcedure.input(...).mutation(...)
// server/routers/connectionsRouter.ts
createTelegramBot: protectedProcedure...
createApiKey: protectedProcedure...
```

Reserve `create` for "this row didn't exist before; we materialised it." If you're linking an existing thing (like attaching a CRM account that already exists in Sotuvchi), `add*` is acceptable (`crmRouter.addAccount`) — but `create*` is the default.

### `update*` — DB update with optional business logic

```ts
// server/routers/destinationsRouter.ts
update: protectedProcedure.input(...).mutation(...)
// server/routers/emailAuthRouter.ts
updateProfile: protectedProcedure...
```

Reserve verb-specific mutation names for non-trivial single-purpose mutations: `regenerateKey`, `rotateSecret`, `saveCanvas`. If it's a generic field set, use `update`.

### `delete*` vs `remove*`

The team uses both. Convention going forward:

- **`delete*`** — soft-delete or row removal where the row identity stays meaningful (e.g., `deleteIntegration` sets `deletedAt` and keeps the row; see [[integrations-soft-delete]]). The DB row is still there, just marked.
- **`remove*`** — hard removal or "unlink" semantics. `removeIntegrationRoute` actually `DELETE FROM …`s.

**Existing inconsistency.** Some tRPC procedures use `delete` for what is functionally a hard delete (`adminAppsRouter.delete`, `crmRouter.deleteAccount`). Don't refactor existing names; just follow the rule in new code.

---

## 2. Service module exports

Three patterns coexist intentionally. Pick the right one for the shape of the data.

### Pattern A — bare named functions (default)

Used by almost every service: `leadService.ts`, `affiliateService.ts`, `connectionService.ts`, `circuitBreaker.ts` (despite the name, it exports bare functions like `recordOutcome` and `evaluateClaim`).

```ts
// server/services/leadService.ts
export async function processLead(...) { ... }
export async function dispatchLead(...) { ... }
```

When to use: stateless operations, or state that's threaded through the function arguments (a `DbClient`, a `userId`).

### Pattern B — namespaced object

Used when many functions share a common API shape and you want call sites to read as `log.info(...)`, `log.warn(...)`, `log.error(...)` instead of `logInfo(...)`, `logWarn(...)`, `logError(...)`.

```ts
// server/services/appLogger.ts
export const log = {
  info: (category, message, meta?, ...) => logEvent({ level: "INFO", ... }),
  warn: (...) => logEvent({ level: "WARN", ... }),
  error: (...) => logEvent({ level: "ERROR", ... }),
};
```

When to use: a family of operations that differ only in a parameter (log level, HTTP method, etc.) where the namespaced call site reads better than a prefix.

### Pattern C — typed Error subclasses

Used for catch-site type discrimination instead of string-matching error messages.

```ts
// server/services/affiliateService.ts
export class SecretDecryptError extends Error { ... }
export class DeliveryBlockedError extends Error { ... }
export class ConnectionSecretMissingError extends Error { ... }
export class ConnectionRequiredError extends Error { ... }
```

When to use: when callers branch on which error class was thrown (`catch (e) { if (e instanceof ConnectionRequiredError) ... }`). Don't add an Error subclass just because; the bar is "a caller pattern-matches on it."

---

## 3. Type and interface naming

### Prefer Drizzle's `$inferSelect` over hand-written interfaces

```ts
// In drizzle/schema.ts (canonical source)
export const orders = mysqlTable("orders", { ... });
export type Order = typeof orders.$inferSelect;
export type InsertOrder = typeof orders.$inferInsert;

// In consumers — import the inferred type, don't re-declare
import type { Order } from "@shared/.../orders";
```

The audit found 2-3 client components that re-declared `interface Order` locally. Don't add more; replace them when convenient.

### External-API shapes — prefix with the source

DB row types use the bare noun (`Order`, `Lead`, `Connection`). External-API shapes should be prefixed so they don't shadow the DB type:

```ts
// Good — clear it's the Facebook API shape, not our DB row
export interface FbAdAccount { ... }
export interface FbCampaign { ... }
```

`server/services/adAccountsService.ts` exports `interface AdAccount` for the FB shape — that's an existing case worth renaming to `FbAdAccount` when convenient (not in this PR).

### Inline component prop types

Local prop types are fine when they describe one component's API:

```ts
// client/src/components/leads/LeadCard.tsx
interface LeadCardProps { lead: Lead; onClick: () => void }
```

If the same prop type appears in more than one file, hoist it to `shared/`.

---

## 4. tRPC procedure naming

### Path structure

- Mutations are verb-first: `create`, `update`, `delete`, `regenerateKey`, `saveCanvas`, `createTelegramBot`.
- Queries returning many items: `list`, `listX` (when there's more than one list per router).
- Queries returning one item: `get`, `getById`, `getDetail`, `getStatus`, `getStats`, `getOverview`, `getSyncStatus`, `getInsights`, `getTimeSeries`, `getBreakdown`.

### When to use `list` vs `listX`

If a router has one list, use bare `list`:

```ts
// destinationsRouter, connectionsRouter, appsRouter, leadsRouter, …
list: protectedProcedure.query(...)
```

If a router has multiple distinct list endpoints, name each one:

```ts
// adAnalyticsRouter
listAdAccounts: protectedProcedure...
listCampaigns: protectedProcedure...
listAdSets: protectedProcedure...
```

### Sub-namespacing

Some routers nest related procedures under a sub-object (`admin.dlq.*` in `adminDlqRouter`, `admin.backfill.*` in `adminBackfillRouter`). This is fine for grouping admin-only or capability-scoped procedures. Don't nest just for taxonomy — only when it expresses a capability boundary.

### Tenant-scope reminder

Every procedure that reads or writes a tenant-scoped table MUST filter by `ctx.user.id` in every query. The audit (Section B.5) caught four UPDATEs that selected ownership but updated by id alone — a TOCTOU window. Pattern: include `eq(<table>.userId, ctx.user.id)` in the `where(...)` of any write, even after a separate SELECT check.

---

## 5. File naming

| Pattern | Used for | Example |
|---|---|---|
| `<thing>Service.ts` | Business-logic services | `leadService.ts`, `connectionService.ts`, `affiliateService.ts` |
| `<thing>Scheduler.ts` | Long-running setInterval workers | `retryScheduler.ts`, `crmSyncScheduler.ts`, `oauthStateCleanupScheduler.ts` |
| `<thing>Router.ts` | tRPC routers | `leadsRouter.ts`, `destinationsRouter.ts`, `crmRouter.ts` |
| `<thing>Adapter.ts` | Delivery adapters (integrations) | `telegramAdapter.ts`, `httpRequestAdapter.ts` |
| `<verb><Object>.ts` | Single-purpose helpers | `assertSafeOutboundUrl.ts`, `resolveAdapterKey.ts`, `extractExternalOrderId.ts` |
| `<thing>.test.ts` | Vitest tests | placed next to the source file they cover |

Test file placement: tests live next to source (`leadService.ts` ↔ `leadService.test.ts`), not in a separate `__tests__/` directory.

---

## 6. Folder layering

The codebase enforces this layering by convention (no lint rule). The audit verified zero violations by grep:

```
routers/        ← tRPC handlers, thin wrappers, no business logic
  ↓
services/       ← business logic, DB writes, third-party calls
  ↓
lib/            ← pure helpers, no DB, no I/O
  ↓
drizzle/        ← schema, types
```

- `client/src/*` imports types from `@shared/*` via tsconfig paths. Server-side modules can also import from `@shared/*` (leaf).
- `shared/` has zero upward dependencies — never import from `server/` or `client/`.
- `server/routers/*` MUST NOT import from another router. Cross-router work goes through a service.
- `server/services/*` MUST NOT import tRPC types (`@trpc/*`). Procedures pass plain inputs in and get plain values back.
- `server/lib/*` MUST NOT import from `services/*`. Helpers stay pure.

### `server/routes/` vs `server/routers/`

- `server/routes/` (5 files) — Express REST handlers (OAuth callbacks, webhooks, brand-icon proxy)
- `server/routers/` (25 files) — tRPC routers (everything client-facing)

Both names autocomplete to each other; this is a known friction. A future rename of `server/routes/` → `server/rest/` is a candidate cleanup, but not in scope for this doc.

---

## When in doubt

- Read the closest existing file in the same folder; copy its shape.
- For a tRPC procedure name, pick the verb that matches what an existing router did for the same kind of operation.
- For an error class vs an error code string: error class only if a caller will pattern-match on it.
- For a `get` vs `fetch`: does the function cross a network boundary you don't own? Then `fetch`. Otherwise `get`.
- For `delete` vs `remove`: does the row leave a `deletedAt` trail (soft-delete)? Then `delete`. Hard `DELETE FROM`? `remove`.
- For inline types vs shared: if it appears in one file, leave it inline. Two files, hoist to `shared/`.

If a convention seems wrong, change it in a focused PR — don't quietly diverge.
