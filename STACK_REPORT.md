# Targenix.uz — Tech Stack Discovery Report

_Generated: 2026-05-16. Branch: `main`. Commit: `4863aaa`._

---

### 1. Project Overview

- **Project name (package.json):** `facebook-lead-ads-webhook` (v1.0.0). Product brand: Targenix.uz.
- **Project type:** Single-repo, **single-app** with two build outputs (web + worker) from one TypeScript codebase. Not a monorepo (no workspace config). Not Next.js — custom Express + Vite SPA with tRPC.
- **Folder structure (top 3 levels):**

```
.
├── client/
│   ├── public/
│   └── src/
│       ├── _core/
│       ├── components/    (appCatalog, builder-v3, common, connections,
│       │                   destinations, dynamic-form, leads, ui, wizard)
│       ├── contexts/
│       ├── hooks/
│       ├── lib/
│       ├── locales/
│       ├── pages/         (40 page components + lead-routing subfolder)
│       └── state/
├── server/
│   ├── _core/             (index.ts entrypoint, trpc, context, env, sdk)
│   ├── boot/
│   ├── integrations/      (adapters, apps, loaders)
│   ├── lib/
│   ├── monitoring/        (sentry, metrics)
│   ├── oauth/             (providers)
│   ├── queues/            (BullMQ + ioredis)
│   ├── routers/           (25 tRPC routers)
│   ├── routes/            (Express-style routes for OAuth + webhooks)
│   ├── services/          (60+ service / scheduler files)
│   ├── utils/
│   ├── webhooks/          (Facebook + Telegram + SSE)
│   └── workers/           (run.ts worker entry, leadWorker.ts)
├── shared/
│   ├── _core/             (errors.ts)
│   └── transformEngine/   (custom expression/evaluator language)
├── drizzle/               (schema.ts + 114 migration files)
├── tooling/               (gitignored ops scripts — backfill, audit, sync)
├── scripts/               (gitignored — see MEMORY)
├── patches/               (wouter@3.7.1 patch)
├── references/
└── .github/workflows/     (ci.yml only)
```

- **File counts (excluding `node_modules`, `dist`, `.git`):**
  - `.ts`     — 890
  - `.tsx`    — 417
  - `.js`     — 2
  - `.mjs`    — 492 (mostly ad-hoc `tooling/` scripts)
  - `.sql`    — 292 (114 in `drizzle/` proper plus snapshots in `drizzle/meta/`)
  - `.json`   — 204
  - `.md`     — 27
- **Lines of code (TS + TSX, excluding node_modules / dist / .claude):** **98,952 total lines**.

### 2. Runtime & Package Manager

- **Node.js:** `.node-version` = `22`. `package.json` `engines.node` = `">=22"`. Railway prod runs Node 24. CI uses Node 22.
- **Package manager:** **pnpm** (`pnpm-lock.yaml` present; `packageManager` = `pnpm@10.4.1`).
- **TypeScript:** `5.9.3`. **Strict mode = ON** (`"strict": true`). `noEmit: true` (transpilation via esbuild/Vite/tsx; `tsc` only typechecks). Module = `ESNext`, moduleResolution = `bundler`, `allowImportingTsExtensions: true`. Path aliases `@/*` → `client/src/*`, `@shared/*` → `shared/*`.

### 3. Backend Framework & API Layer

- **Framework:** **Express 4.21** + **tRPC v11** mounted at `/api/trpc` via `@trpc/server/adapters/express`. NOT Next.js, NOT NestJS, NOT Fastify.
- **API style:** Primarily **tRPC** (typed end-to-end with superjson). REST is used for: webhooks (`/api/webhooks/*`, `/api/telegram/webhook`, `/api/trigger`), OAuth callbacks, health (`/api/health`), brand icons.
- **Router files (all in `server/routers/`):** [adAnalyticsRouter.ts](server/routers/adAnalyticsRouter.ts), [adminAppActionsRouter.ts](server/routers/adminAppActionsRouter.ts), [adminAppsRouter.ts](server/routers/adminAppsRouter.ts), [adminBackfillRouter.ts](server/routers/adminBackfillRouter.ts), [adminDlqRouter.ts](server/routers/adminDlqRouter.ts), [adminLeadsRouter.ts](server/routers/adminLeadsRouter.ts), [adminTemplatesRouter.ts](server/routers/adminTemplatesRouter.ts), [appsRouter.ts](server/routers/appsRouter.ts), [connectionsRouter.ts](server/routers/connectionsRouter.ts), [crmRouter.ts](server/routers/crmRouter.ts), [destinationsRouter.ts](server/routers/destinationsRouter.ts), [emailAuthRouter.ts](server/routers/emailAuthRouter.ts), [facebookAccountsRouter.ts](server/routers/facebookAccountsRouter.ts), [googleAccountsRouter.ts](server/routers/googleAccountsRouter.ts), [googleRouter.ts](server/routers/googleRouter.ts), [insightsRouter.ts](server/routers/insightsRouter.ts), [integrationsRouter.ts](server/routers/integrationsRouter.ts), [leadsRouter.ts](server/routers/leadsRouter.ts), [logsRouter.ts](server/routers/logsRouter.ts), [metricsRouter.ts](server/routers/metricsRouter.ts), [telegramRouter.ts](server/routers/telegramRouter.ts), [triggersRouter.ts](server/routers/triggersRouter.ts), [webhookRouter.ts](server/routers/webhookRouter.ts), [workflowsRouter.ts](server/routers/workflowsRouter.ts) + `systemRouter` (in `_core`). Composition: [server/routers.ts](server/routers.ts).
- **REST/route files:** [server/routes/brandIconsRouter.ts](server/routes/brandIconsRouter.ts), [facebookLoginOAuth.ts](server/routes/facebookLoginOAuth.ts), [facebookOAuthCallback.ts](server/routes/facebookOAuthCallback.ts), [oauthRouter.ts](server/routes/oauthRouter.ts), [triggerWebhookRoute.ts](server/routes/triggerWebhookRoute.ts).
- **Webhook files:** [server/webhooks/facebookWebhook.ts](server/webhooks/facebookWebhook.ts), [telegramWebhook.ts](server/webhooks/telegramWebhook.ts), [sseEmitter.ts](server/webhooks/sseEmitter.ts).
- **Middleware:** `helmet` (full CSP — see [server/_core/index.ts:168](server/_core/index.ts#L168)); layered `express-rate-limit` (auth 10/15min, password-reset 5/hr, webhooks 500/min, global API 200/min); raw-body capture for webhook HMAC; `traceIdMiddleware` (AsyncLocalStorage propagation); custom `httpLogger`. tRPC middleware: `trpcLogger`, `requireUser`, `adminAuditMiddleware`.

### 4. Database & ORM

- **Engine:** **MySQL** via `mysql2` (`^3.15.0`). Pool size `DB_POOL_LIMIT` (default 20). Session TZ pinned to UTC. Hosted on Railway.
- **ORM:** **Drizzle ORM** (`drizzle-orm ^0.44.5`) + `drizzle-kit ^0.31.4` for migrations. Dialect: `mysql`.
- **Schema file:** [drizzle/schema.ts](drizzle/schema.ts) — single file, 1,598 lines. (`drizzle/relations.ts` is 1 line — effectively unused.)
- **Total tables/models:** **41 `mysqlTable` definitions**.
- **Tables with field counts** (counted by typed column definitions):

| Table | Fields | Table | Fields |
|---|---|---|---|
| users | 19 | leads | 37 |
| telegram_chats | 11 | orders | 32 |
| telegram_pending_chats | 12 | order_events | 10 |
| password_reset_tokens | 6 | webhook_events | 10 |
| facebook_accounts | 10 | app_logs | 18 |
| facebook_connections | 12 | ad_accounts | 20 |
| facebook_forms | 11 | campaigns | 15 |
| oauth_states | n/a (composite) | ad_sets | 17 |
| oauth_tokens | n/a (composite) | campaign_insights | 16 |
| apps | 11 | crm_connections | 14 |
| app_actions | n/a (composite) | triggers | 12 |
| destination_templates | 16 | trigger_executions | 11 |
| connections | 16 | workflows | 12 |
| connection_health_logs | 9 | workflow_steps | 9 |
| connection_events | 9 | workflow_executions | 12 |
| destinations | 14 | workflow_step_executions | 12 |
| integrations | 18 | circuit_breakers | 27 |
| integration_routes | n/a (composite) | circuit_breaker_events | 12 |
| admin_audit_log | 14 | metric_snapshots | 8 |
| fact_attribution_daily | 31 | campaign_daily_insights | 15 |
| fx_rates | 7 | | |

- **Migrations:** **114 SQL files** in `drizzle/` (numbered `0000`…`0090` plus rollbacks). One legacy migration in `drizzle/migrations/0001_leads_denormalize.sql`. Tool: **drizzle-kit**. Custom backfill journal helper: `tooling/drizzle/backfill-migration-journal-0026-0027.mjs`.

### 5. Authentication

- **Library:** **Custom JWT** implementation built on `jose` (`6.1.0`). No NextAuth / Auth.js / Clerk / Lucia / Better-Auth.
- **Session strategy:** Stateless **JWT-in-cookie** (HS256, secret = `JWT_SECRET`). Cookie name from `@shared/const` (`COOKIE_NAME`); expiration from `SESSION_EXPIRATION_MS`. JWT `iat` validated against `users.passwordChangedAt` to invalidate sessions after password reset. See [server/_core/sdk.ts](server/_core/sdk.ts).
- **Password hashing:** `bcryptjs` (`^3.0.3`). `@node-rs/argon2` is in deps but not used as primary hash (likely for migrations).
- **OAuth providers configured:**
  - **Facebook** — both Login (account creation) and Connection flows. Routes: `registerFacebookLoginRoutes`, `registerFacebookOAuthRoutes`. CSRF state stored in `oauth_states`.
  - **Google** — OAuth 2.0 for Sheets/Drive. Provider: [server/oauth/providers/google.provider.ts](server/oauth/providers/google.provider.ts). Tokens in unified `oauth_tokens` table.
  - **Generic OAuth2** providers: [hubspot.provider.ts](server/oauth/providers/hubspot.provider.ts), [kommo.provider.ts](server/oauth/providers/kommo.provider.ts), [pipedrive.provider.ts](server/oauth/providers/pipedrive.provider.ts), plus a `generic.provider.ts` fallback.
- **Telegram** — bot-token-based linking (not OAuth) via one-time `telegramConnectToken`.

### 6. Multi-tenancy Implementation

- **Strategy:** **Single database, single schema**. Tenant scoping via a **`userId INT` column on every per-tenant table** — explicit `WHERE userId = ?` in every query. No row-level security, no per-tenant schemas, no workspaceId abstraction (users ARE the tenant boundary).
- **Tables carrying `userId`** (19 of 41): `telegram_chats`, `password_reset_tokens`, `facebook_accounts`, `facebook_connections`, `facebook_forms`, `oauth_states`, `oauth_tokens`, `connections`, `destinations`, `integrations`, `leads`, `orders`, `order_events`, `app_logs`, `ad_accounts`, `campaigns`, `ad_sets`, `campaign_insights`, `crm_connections`. (27 total userId-typed columns including composite-key tables and the implicit `claimedByUserId` on `telegram_pending_chats`.)
- **Enforcement:** **No central tenant middleware.** Each tRPC procedure is responsible for adding `eq(table.userId, ctx.user.id)`. There IS a dedicated regression test: [server/multiTenantIsolation.test.ts](server/multiTenantIsolation.test.ts). `protectedProcedure` ensures `ctx.user` is non-null, but does not auto-inject userId into queries.
- **Admin escape hatch:** `adminProcedure` (in [server/_core/trpc.ts](server/_core/trpc.ts)) requires `ctx.user.role === 'admin'` and writes a forensic row to `admin_audit_log` on every mutation.

### 7. Background Jobs & Queues

- **Queue:** **BullMQ** (`^5.70.4`) backed by **Redis** via `ioredis` (`^5.10.0`). Single queue named `lead-processing`. Definition: [server/queues/leadQueue.ts](server/queues/leadQueue.ts). Default job options: 3 attempts, exponential 5s backoff, keeps last 100 completed / 200 failed.
- **Worker entry:** [server/workers/run.ts](server/workers/run.ts) (standalone process) + [server/workers/leadWorker.ts](server/workers/leadWorker.ts) (the processor). Embedded mode controlled by `START_WORKER=true`.
- **Schedulers (in-process intervals, NOT node-cron / Vercel Cron):** 12 total, all started in the worker process:
  - [retryScheduler.ts](server/services/retryScheduler.ts)
  - [logRetentionScheduler.ts](server/services/logRetentionScheduler.ts)
  - [formsRefreshScheduler.ts](server/services/formsRefreshScheduler.ts)
  - [adsSyncScheduler.ts](server/services/adsSyncScheduler.ts)
  - [crmSyncScheduler.ts](server/services/crmSyncScheduler.ts)
  - [connectionHealthScheduler.ts](server/services/connectionHealthScheduler.ts)
  - [leadPollingService.ts](server/services/leadPollingService.ts) (`startLeadPollingScheduler`, gated by `ENABLE_LEAD_POLLING`)
  - [triggerScheduler.ts](server/services/triggerScheduler.ts)
  - [oauthStateCleanupScheduler.ts](server/services/oauthStateCleanupScheduler.ts)
  - [metricSnapshotScheduler.ts](server/services/metricSnapshotScheduler.ts)
  - [insightsRollupScheduler.ts](server/services/insightsRollupScheduler.ts)
  - [fxRateScheduler.ts](server/services/fxRateScheduler.ts)
- **Production assertion:** Web process aborts on boot if `REDIS_URL` is unset and `NODE_ENV=production` (see [server/_core/index.ts:386](server/_core/index.ts#L386)). Worker process aborts on boot if `REDIS_URL` is unset (any env).
- **Deployment topology:** Two Railway services from one codebase — `web` runs `dist/index.js`, `worker` runs `dist/worker.js`. See `Procfile` (`web`) and `railway.toml`.

### 8. External Integrations

- **Lead source (inbound):** **Facebook Graph API** (Lead Ads webhooks + lead enrichment). Service: [server/services/facebookGraphService.ts](server/services/facebookGraphService.ts), [facebookFormsService.ts](server/services/facebookFormsService.ts), [facebookService.ts](server/services/facebookService.ts). Page-guard: [facebookPageGuard.ts](server/services/facebookPageGuard.ts). Webhook: [server/webhooks/facebookWebhook.ts](server/webhooks/facebookWebhook.ts).
- **Ad insights:** Facebook Marketing API via [adsSyncService.ts](server/services/adsSyncService.ts).
- **CRM (outbound destinations) — app manifests in [server/integrations/apps/](server/integrations/apps/):**
  - **AmoCRM** ([amocrm.ts](server/integrations/apps/amocrm.ts)) — `http-api-key`
  - **Bitrix24** ([bitrix24.ts](server/integrations/apps/bitrix24.ts)) — `http-api-key`
  - **HubSpot** ([hubspot.ts](server/integrations/apps/hubspot.ts)) — `http-oauth2`
  - **Kommo** ([kommo.ts](server/integrations/apps/kommo.ts)) — `http-oauth2`
  - **Pipedrive** ([pipedrive.ts](server/integrations/apps/pipedrive.ts)) — `http-oauth2`
- **Other outbound apps:**
  - **Google Sheets** ([googleSheets.ts](server/integrations/apps/googleSheets.ts)) + service [googleSheetsService.ts](server/services/googleSheetsService.ts)
  - **Telegram** ([telegram.ts](server/integrations/apps/telegram.ts)) — bot delivery via `node-telegram-bot-api` types
  - **Eskiz SMS** ([eskizSms.ts](server/integrations/apps/eskizSms.ts)) — Uzbek SMS provider
  - **PlayMobile SMS** ([playmobileSms.ts](server/integrations/apps/playmobileSms.ts)) — Uzbek SMS provider
  - **OpenAI** ([openAi.ts](server/integrations/apps/openAi.ts)) — used via `@ai-sdk/openai`
  - **Generic HTTP** ([httpRequest.ts](server/integrations/apps/httpRequest.ts)) — universal webhook/REST adapter
  - **Dynamic templates** ([dynamicTemplate.ts](server/integrations/apps/dynamicTemplate.ts)) — admin-defined destination templates
- **Affiliate / CRM (per MEMORY):** **100k.uz** (affiliate API) — service in `tooling/run-100k-crm-sync-once.ts` and [crmService.ts](server/services/crmService.ts).
- **FX rates:** Central Bank of Uzbekistan (CBU) USD/UZS — [fxRateService.ts](server/services/fxRateService.ts).
- **Email:** `nodemailer` via SMTP — [emailService.ts](server/services/emailService.ts).
- **Adapters (transport layer in [server/integrations/adapters/](server/integrations/adapters/)):** `dynamicTemplateAdapter`, `googleSheetsAdapter`, `httpApiKeyAdapter`, `httpOAuth2Adapter`, `httpRequestAdapter`, `telegramAdapter`.
- **Inbound webhook endpoints:**
  - `POST /api/webhooks/*` — Facebook Lead Ads (HMAC-verified)
  - `POST /api/telegram/webhook` — Telegram Bot updates
  - `POST /api/trigger/*` — user-defined trigger webhooks (workflow engine)
  - `GET /api/auth/facebook/*`, `/api/oauth/*` — OAuth callbacks

### 9. Validation & Type Safety

- **Library:** **Zod v4** (`^4.1.12`). Used in 24 of 25 router files. No Valibot/Yup.
- **Where schemas live:** Inline in tRPC procedure definitions (`procedure.input(z.object({...}))`). No central `schemas/` directory.
- **End-to-end typing:** Yes — `AppRouter` type is exported from [server/routers.ts](server/routers.ts) and consumed by `createTRPCReact<AppRouter>()` in [client/src/lib/trpc.ts](client/src/lib/trpc.ts). superjson transformer preserves Date/BigInt across the wire.
- **Boundary validation:** Webhook payloads validated via HMAC + custom parsers (no Zod for raw Facebook payloads). Environment validation in [server/_core/validateEnv.ts](server/_core/validateEnv.ts) (manual checks, not Zod).

### 10. State Management & Frontend (same repo)

- **React:** `19.2.1`. Bundler: **Vite 7.1.7** with `@vitejs/plugin-react`. Manual chunks split out `vendor-react`, `vendor-ui`, `vendor-query`, `vendor-charts`, plus a `landing` chunk for `LandingPage.tsx`.
- **Routing:** **wouter** (`3.7.1`, patched via `patches/wouter@3.7.1.patch`). NOT React Router. NOT Next.js.
- **Server-state:** **@tanstack/react-query 5.90.2** wired through `@trpc/react-query 11.6.0`.
- **Client-state:** Mostly local component state. One Zustand-style file: [client/src/state/builderV3State.ts](client/src/state/builderV3State.ts) (manual store, not the `zustand` package — `zustand` is NOT in deps). React Context for `LocaleContext`, `ThemeContext` (next-themes).
- **UI library:** **shadcn/ui (new-york style)** on top of **Radix UI primitives** (15 `@radix-ui/*` packages). 27 UI components in [client/src/components/ui/](client/src/components/ui/). Tailwind CSS 4.x via `@tailwindcss/vite`. Icons: `lucide-react`, `simple-icons`. Toasts: `sonner`. Command palette: `cmdk`. Charts: `recharts 2.15`. Virtualization: `@tanstack/react-virtual`. Flow canvas: `@xyflow/react` (used in workflow builder).
- **Forms:** **No react-hook-form, no formik.** Custom dynamic-form system in [client/src/components/dynamic-form/](client/src/components/dynamic-form/) and `client/src/components/wizard/`, driven by manifest field definitions.

### 11. Testing

- **Runner:** **Vitest 2.1.4** (`environment: node`). No Jest. No Playwright tests (only Playwright **MCP server** present in `.playwright-mcp/`).
- **Test files:** **141 `.test.ts` files**, 0 `.spec.ts`. Tests live next to source. CI doc claims `~513 tests`.
- **Coverage:** **Coverage NOT configured.** No `@vitest/coverage-*` package in deps; `vitest.config.ts` has no `coverage` block. Coverage % cannot be reported. The CI workflow ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs `pnpm test` without coverage. Per the CI comment, ~500/513 tests are pure-logic and the rest self-skip when `DATABASE_URL` is absent.

### 12. Deployment & Monitoring

- **Deployed on:** **Railway** (two services: `web` + `worker` from same repo). `railway.toml` configures Nixpacks build; `Procfile` declares the web start command. **No Vercel, no Dockerfile, no docker-compose.yml, no PM2 ecosystem file.**
- **CI/CD:** Single GitHub Actions workflow [.github/workflows/ci.yml](.github/workflows/ci.yml) — runs `pnpm check` (tsc) + `pnpm test` on push/PR to `main`. No deploy step (Railway auto-deploys on push to `main`).
- **Error monitoring:** **Sentry** via `@sentry/node ^10.52.0`. Init at [server/monitoring/sentry.ts](server/monitoring/sentry.ts). No-op when `SENTRY_DSN` is unset. Release tag = `RAILWAY_GIT_COMMIT_SHA[:12]`.
- **Application logging:** Custom DB-backed logger [server/services/appLogger.ts](server/services/appLogger.ts) writing to `app_logs` table. Console logs in dev. **No winston / pino / bunyan.**
- **Metrics:** Custom in-process metrics in [server/monitoring/metrics.ts](server/monitoring/metrics.ts), persisted as snapshots to `metric_snapshots` table by `metricSnapshotScheduler`.
- **Analytics (client):** Custom analytics endpoint configured via `VITE_ANALYTICS_ENDPOINT` + `VITE_ANALYTICS_WEBSITE_ID`. **No PostHog, no Mixpanel, no Segment, no GA.**

### 13. Environment Variables

- **Unique env vars referenced in source:** **57 distinct `process.env.*` references** across `server/`, `client/`, `shared/`.
- **`.env.example`:** **MISSING.** Only `.env` exists locally (22 keys; 1,833 bytes). No example template is committed for new contributors.
- **Required at boot (validated by [server/_core/validateEnv.ts](server/_core/validateEnv.ts)):** `APP_URL`, `FACEBOOK_APP_SECRET`, `FACEBOOK_VERIFY_TOKEN`, `ENCRYPTION_KEY` (must be exactly 32 chars, weak-pattern rejection), `JWT_SECRET` (≥32 chars), and ONE of `MYSQL_PUBLIC_URL`/`MYSQL_URL`/`DATABASE_URL`.
- **Vars used in code but NOT in local `.env`** (potential config drift / missing local setup):
  - **Database:** `MYSQL_URL`, `MYSQL_PUBLIC_URL`
  - **Queue/Redis:** `REDIS_URL`
  - **Google OAuth:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`
  - **Telegram bot:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`
  - **Sentry:** `SENTRY_DSN`, `SENTRY_RELEASE`, `SENTRY_TRACES_SAMPLE_RATE`
  - **Worker tuning:** `START_WORKER`, `WORKER_CONCURRENCY`, `WORKER_HEALTH_PORT`, `RETRY_CONCURRENCY`, `RETRY_RATE_PER_SEC`, `RETRY_ORDER_TICK_BATCH`, `LEAD_RETRY_BACKOFF_MS`, `ORDER_RETRY_BACKOFF_MS`, `WORKFLOW_FIRE_MAX_CONCURRENT`
  - **Feature flags / debug:** `ENABLE_LEAD_POLLING`, `CB_ENFORCEMENT`, `CB_ALERT_TELEGRAM_CHAT_ID`, `OAUTH_DEBUG`, `BRAND_ICON_LOG`, `METRICS_LOG`, `STAGE2_ADAPTER_LOG`, `STAGE2_APPS_LOG`, `STAGE2_APP_ROUTING_LOG`, `STAGE2_DYNAMIC_TEMPLATE_LOG`, `STAGE2_SPEC_LOG`, `TYPE_VALIDATION_LOG`
  - **Platform-injected (Railway / Node):** `NODE_ENV`, `PORT`, `HOSTNAME`, `RAILWAY_GIT_COMMIT_SHA`, `RAILWAY_REPLICA_ID`
  - **Misc:** `APP_BASE_URL` (alias?), `FORGE_API_KEY` (vs. `BUILT_IN_FORGE_API_KEY` which IS in .env)

### 14. Dependencies Snapshot

- **Counts:** **51 runtime dependencies + 19 devDependencies = 70 total.**
- **`pnpm outdated` (full output):**

| Package | Current | Latest |
|---|---|---|
| @types/bcryptjs | 3.0.0 | **Deprecated** |
| @types/express-rate-limit (dev) | 6.0.2 | **Deprecated** |
| @ai-sdk/openai | 3.0.12 | 3.0.64 |
| @types/react (dev) | 19.2.8 | 19.2.14 |
| ai | 6.0.38 | 6.0.184 |
| ioredis | 5.10.0 | 5.10.1 |
| nanoid | 5.1.6 | 5.1.11 |
| nodemailer | 8.0.5 | 8.0.7 |
| prettier (dev) | 3.8.0 | 3.8.3 |
| react | 19.2.3 | 19.2.6 |
| react-dom | 19.2.3 | 19.2.6 |
| @sentry/node | 10.52.0 | 10.53.1 |
| @tailwindcss/vite (dev) | 4.1.18 | 4.3.0 |
| @tanstack/react-query | 5.90.17 | 5.100.10 |
| @trpc/client | 11.8.1 | 11.17.0 |
| @trpc/react-query | 11.8.1 | 11.17.0 |
| @trpc/server | 11.8.1 | 11.17.0 |
| @types/google.maps (dev) | 3.58.1 | 3.64.1 |
| axios | 1.13.2 | 1.16.1 |
| bullmq | 5.70.4 | 5.76.9 |
| dotenv | 17.2.3 | 17.4.2 |
| express-rate-limit | 8.3.2 | 8.5.2 |
| jose | 6.1.0 | 6.2.3 |
| mysql2 | 3.16.1 | 3.22.3 |
| simple-icons | 16.18.1 | 16.19.0 |
| tailwind-merge | 3.4.0 | 3.6.0 |
| tailwindcss (dev) | 4.1.18 | 4.3.0 |
| tsx (dev) | 4.21.0 | 4.22.0 |
| wouter | 3.7.1 | 3.9.0 |
| zod | 4.3.5 | 4.4.3 |
| **@types/express (dev)** | **4.17.21** | **5.0.6** ⚠ major |
| **@types/node (dev)** | **24.10.9** | **25.8.0** ⚠ major |
| **@vitejs/plugin-react (dev)** | **5.1.2** | **6.0.2** ⚠ major |
| **express** | **4.22.1** | **5.2.1** ⚠ major |
| **recharts** | **2.15.4** | **3.8.1** ⚠ major |
| **superjson** | **1.13.3** | **2.2.6** ⚠ major |
| **typescript (dev)** | **5.9.3** | **6.0.3** ⚠ major |
| **vite (dev)** | **7.3.1** | **8.0.13** ⚠ major |
| **vitest (dev)** | **2.1.9** | **4.1.6** ⚠ major (2 majors behind) |
| drizzle-kit (dev) | 0.31.8 | 0.31.10 |
| drizzle-orm | 0.44.7 | 0.45.2 |
| esbuild (dev) | 0.25.12 | 0.28.0 |
| **lucide-react** | **0.453.0** | **1.16.0** ⚠ major (1.x is GA) |

- **≥1 major version behind:** `@types/express` (4→5), `@types/node` (24→25), `@vitejs/plugin-react` (5→6), `express` (4→5), `recharts` (2→3), `superjson` (1→2), `typescript` (5→6), `vite` (7→8), `vitest` (2→4, two majors), `lucide-react` (0.x→1.x).
- **Deprecated `@types`:** `@types/bcryptjs` and `@types/express-rate-limit` no longer maintained (the libraries now ship their own types).

### 15. Key Files Inventory

#### Root config files

| File | Purpose |
|---|---|
| [package.json](package.json) | Scripts (`dev`/`dev:worker`/`build`/`start`/`start:worker`/`check`/`format`/`test`/`db:push`), deps, `pnpm.patchedDependencies`, `pnpm.overrides` (forces `nanoid@3.3.7` for tailwind subdep) |
| [tsconfig.json](tsconfig.json) | Strict TS, ESNext + bundler resolution, `@/*` & `@shared/*` aliases, `noEmit: true` |
| [vite.config.ts](vite.config.ts) | Vite root = `client/`, output `dist/public`, dev proxy `/api → :3000`, manual chunks for vendors |
| [vitest.config.ts](vitest.config.ts) | Node env, includes `server/**`, `client/src/**`, `shared/**` test patterns |
| [drizzle.config.ts](drizzle.config.ts) | MySQL dialect, schema at `drizzle/schema.ts`, prefers TCP URLs |
| [railway.toml](railway.toml) | Nixpacks build, on_failure restart x3; per-service start cmd set in Railway UI |
| [Procfile](Procfile) | `web: node dist/index.js` (Heroku-style; consumed by Railway) |
| [components.json](components.json) | shadcn config (new-york style, neutral base, `@/components/ui`) |
| [.node-version](.node-version) | `22` |
| [.gitignore](.gitignore) | Standard + `scripts/`, `.manus/`, `tooling/mysql/dumps/`, `backup_*.json`, `wapi-*.png`, `.playwright-mcp/`, `.mcp.json` |
| [.prettierrc](.prettierrc) / [.prettierignore](.prettierignore) | Code formatting |
| [.mcp.json](.mcp.json) | Local-only MCP server config (gitignored) |
| [README.md](README.md) | 28.6 KB project docs |
| [ROADMAP.md](ROADMAP.md) | Active roadmap |
| [MIGRATION_PLAN_http_refactor.md](MIGRATION_PLAN_http_refactor.md) | HTTP adapter refactor plan |
| [todo.md](todo.md) | Legacy task list |
| [knip.audit.json](knip.audit.json) | Dead-code audit output |
| [backup_*.json](backup_api_keys.json) | One-off rollback backups (gitignored, plaintext secrets) |

#### `/server/lib` — pure utility modules

| File | Purpose |
|---|---|
| [circuitPolicy.ts](server/lib/circuitPolicy.ts) | Circuit-breaker thresholds + state transition policy |
| [dashboardTimezone.ts](server/lib/dashboardTimezone.ts) | Asia/Tashkent day-boundary UTC math for dashboard windows |
| [envHelpers.ts](server/lib/envHelpers.ts) | `envInt`/`envBool` typed env-var readers with defaults |
| [fetchBounded.ts](server/lib/fetchBounded.ts) | `fetch` wrapper with timeout + max response size + SSRF guard |
| [leadEnrichmentRetryPolicy.ts](server/lib/leadEnrichmentRetryPolicy.ts) | Backoff schedule for Facebook lead-detail retries |
| [leadPipeline.ts](server/lib/leadPipeline.ts) | Pipeline status state machine (PENDING → ENRICHED → SUCCESS) |
| [orderRetryPolicy.ts](server/lib/orderRetryPolicy.ts) | Per-status delivery retry policy |
| [password.ts](server/lib/password.ts) | bcrypt hash + verify helpers |
| [phoneValidation.ts](server/lib/phoneValidation.ts) | E.164 normalization for UZ/RU/other |
| [requestContext.ts](server/lib/requestContext.ts) | AsyncLocalStorage trace-id propagation (`runWithRequestContext`, `getTraceId`) |
| [urlSafety.ts](server/lib/urlSafety.ts) | SSRF/private-IP guard for outbound HTTP |
| [userRateLimit.ts](server/lib/userRateLimit.ts) | Per-userId rate limit primitive |
| [webhookRateLimit.ts](server/lib/webhookRateLimit.ts) | Per-page-id webhook rate limit |

#### `/server/services` — business logic & schedulers (61 files; non-test shown)

| File | Purpose |
|---|---|
| [adAccountsService.ts](server/services/adAccountsService.ts) | Facebook ad-account CRUD + Graph sync |
| [adminAuditService.ts](server/services/adminAuditService.ts) | Writes `admin_audit_log` rows from tRPC middleware |
| [adsSyncScheduler.ts](server/services/adsSyncScheduler.ts) | Periodically syncs Facebook ad accounts/campaigns/ad sets |
| [adsSyncService.ts](server/services/adsSyncService.ts) | Marketing API client + cursor pagination |
| [affiliateService.ts](server/services/affiliateService.ts) | Affiliate brand-domain attribution logic |
| [appLogger.ts](server/services/appLogger.ts) | DB-backed structured logger (`log.info/warn/error`) writing to `app_logs` |
| [circuitBreaker.ts](server/services/circuitBreaker.ts) | Per-target circuit breaker (open/half-open/closed) with persistence |
| [connectionEventsService.ts](server/services/connectionEventsService.ts) | Records connection lifecycle events |
| [connectionExpirationNotifier.ts](server/services/connectionExpirationNotifier.ts) | Sends expiry warnings before OAuth tokens lapse |
| [connectionHealthScheduler.ts](server/services/connectionHealthScheduler.ts) | Re-probes stale connections every 10 min |
| [connectionHealthService.ts](server/services/connectionHealthService.ts) | Health check implementation per provider |
| [connectionService.ts](server/services/connectionService.ts) | Connection CRUD + secret handling |
| [crmCircuitBreaker.ts](server/services/crmCircuitBreaker.ts) | CRM-specific breaker variant |
| [crmService.ts](server/services/crmService.ts) | 100k.uz / generic CRM order sync |
| [crmSyncScheduler.ts](server/services/crmSyncScheduler.ts) | Periodic CRM order pull |
| [emailService.ts](server/services/emailService.ts) | Nodemailer SMTP wrapper (password reset emails) |
| [facebookFormsService.ts](server/services/facebookFormsService.ts) | Lead-form metadata + question schema sync |
| [facebookGraphService.ts](server/services/facebookGraphService.ts) | Generic Graph API HTTP client |
| [facebookPageGuard.ts](server/services/facebookPageGuard.ts) | Verifies user owns FB page before subscribing |
| [facebookService.ts](server/services/facebookService.ts) | High-level FB orchestration |
| [filterEngine.ts](server/services/filterEngine.ts) | Workflow filter/condition evaluator |
| [formsRefreshScheduler.ts](server/services/formsRefreshScheduler.ts) | Periodic FB form re-sync |
| [fxRateScheduler.ts](server/services/fxRateScheduler.ts) | Every 6h pulls CBU USD/UZS rate |
| [fxRateService.ts](server/services/fxRateService.ts) | CBU rate fetch + cache |
| [googleService.ts](server/services/googleService.ts) | Google OAuth + identity helpers |
| [googleSheetsService.ts](server/services/googleSheetsService.ts) | Sheets append/values API |
| [insightsRollupScheduler.ts](server/services/insightsRollupScheduler.ts) | Every 15 min, rebuilds `fact_attribution_daily` over 7-day window |
| [integrationRoutes.ts](server/services/integrationRoutes.ts) | N:1 destination-mapping table writer (replaces legacy single `destinationId`) |
| [leadDispatch.ts](server/services/leadDispatch.ts) | Routes leads to queue or in-process worker (mode: queue/in-process) |
| [leadGraphRetryScheduler.ts](server/services/leadGraphRetryScheduler.ts) | Retries Graph API lead-detail fetches |
| [leadPollingService.ts](server/services/leadPollingService.ts) | Zapier-style 10-min fallback poll for missed webhook leads |
| [leadService.ts](server/services/leadService.ts) | Lead persistence + fanout to destinations |
| [logRetentionScheduler.ts](server/services/logRetentionScheduler.ts) | Prunes old `app_logs` rows |
| [metricSnapshotScheduler.ts](server/services/metricSnapshotScheduler.ts) | Every 5 min, snapshots failed_orders/oauth_errors/retry counts → `metric_snapshots` |
| [metricsService.ts](server/services/metricsService.ts) | In-process counter aggregation |
| [oauthStateCleanupScheduler.ts](server/services/oauthStateCleanupScheduler.ts) | Hourly sweep of expired `oauth_states` CSRF rows |
| [orderRetryScheduler.ts](server/services/orderRetryScheduler.ts) | Per-order delivery retry loop |
| [retryScheduler.ts](server/services/retryScheduler.ts) | Top-level retry loop |
| [telegramFormatter.ts](server/services/telegramFormatter.ts) | Renders lead → Telegram message HTML |
| [telegramService.ts](server/services/telegramService.ts) | Bot API client (sendMessage, getMe, set webhook) |
| [templateEngine.ts](server/services/templateEngine.ts) | Variable substitution for destination templates |
| [triggerScheduler.ts](server/services/triggerScheduler.ts) | Workflow trigger evaluator |
| [workflowExecutor.ts](server/services/workflowExecutor.ts) | Workflow step runner (DAG traversal, retries) |

#### `/server/_core` — application bootstrap

| File | Purpose |
|---|---|
| [index.ts](server/_core/index.ts) | Web server entrypoint — Sentry init, helmet+CSP, rate limits, body parsers, all route registration, `/api/health`, Vite dev middleware vs static serving, optional embedded worker |
| [trpc.ts](server/_core/trpc.ts) | tRPC `t` init, `publicProcedure`/`protectedProcedure`/`adminProcedure`, `trpcLogger`, `adminAuditMiddleware` |
| [context.ts](server/_core/context.ts) | tRPC context factory — calls `sdk.authenticateRequest()`, attaches traceId |
| [sdk.ts](server/_core/sdk.ts) | Session SDK — JWT sign/verify (jose, HS256), throttled `lastSignedIn` update, password-change session invalidation |
| [env.ts](server/_core/env.ts) | Frozen `ENV` constants object |
| [validateEnv.ts](server/_core/validateEnv.ts) | Boot-time required-var check, ENCRYPTION_KEY strength check, HTTPS APP_URL in prod |
| [cookies.ts](server/_core/cookies.ts) | Cookie serialization helpers |
| [chat.ts](server/_core/chat.ts) | Chat routes (currently disabled at boot — no auth guard) |
| [globalErrorHandlers.ts](server/_core/globalErrorHandlers.ts) | `process.on('uncaughtException'/'unhandledRejection')` installers |
| [httpLogging.ts](server/_core/httpLogging.ts) | HTTP logger helpers |
| [notification.ts](server/_core/notification.ts) | (admin notifications dispatch) |
| [patchedFetch.ts](server/_core/patchedFetch.ts) | Global `fetch` patch for tracing |
| [publicUser.ts](server/_core/publicUser.ts) | Strips sensitive fields from `User` for client serialization |
| [systemRouter.ts](server/_core/systemRouter.ts) | tRPC `system.*` namespace (health, server info) |
| [vite.ts](server/_core/vite.ts) | `setupVite()` dev middleware + `serveStatic()` for prod |
| [types/cookie.d.ts](server/_core/types/cookie.d.ts) | Local ambient types |

#### `/shared` — shared between client and server

| File | Purpose |
|---|---|
| [const.ts](shared/const.ts) | `COOKIE_NAME`, `SESSION_EXPIRATION_MS`, error messages (`UNAUTHED_ERR_MSG`, `NOT_ADMIN_ERR_MSG`) |
| [affiliateBrandDomains.ts](shared/affiliateBrandDomains.ts) | Affiliate brand → domain mapping |
| [crmStatuses.ts](shared/crmStatuses.ts) | Canonical CRM status enum |
| [extractExternalOrderId.ts](shared/extractExternalOrderId.ts) | Order id extraction from CRM responses |
| [googleSheets.ts](shared/googleSheets.ts) | Sheet-id / range parsing constants |
| [slugify.ts](shared/slugify.ts) | URL-safe slug generator |
| [tempAccess.ts](shared/tempAccess.ts) | Temporary access grant logic (used by template-editor access — see MEMORY) |
| [_core/errors.ts](shared/_core/errors.ts) | `HttpError`, `BadRequestError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError` |
| [transformEngine/](shared/transformEngine/) | Custom expression language: `tokenizer` → `parser` → `evaluator` + `functions` library — used by dynamic-form / template variable resolution |

---

_End of report._
