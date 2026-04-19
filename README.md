# Targenix

> **Facebook Lead Ads automation platform** — receive, enrich, route, and monitor leads in real time.

[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green)](https://nodejs.org) [![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](./LICENSE)

---

## 🚀 Overview

**Targenix** is a multi-tenant SaaS automation platform purpose-built for **Facebook and Instagram Lead Ads**. It sits between Meta's webhook infrastructure and your downstream destinations (Telegram channels, HTTP endpoints, CRMs) — handling ingestion, enrichment, routing, retry logic, and observability in one hosted product.

**Who it is for:**
- Performance marketers and agencies running Lead Ad campaigns at scale
- SMBs that want instant lead notifications in Telegram without writing code
- Technical teams that need a reliable, auditable pipeline from Meta to internal systems

**Core value proposition:** Connect a Facebook Page in the dashboard, define a routing rule (page + form → destination), and every new lead flows to your destination within seconds — with automatic retries, structured logs, and a delivery status you can track.

---

## ⚙️ How It Works

```
Facebook / Instagram Lead Ad (user submits form)
        │
        ▼
POST /api/webhooks/facebook
  ├─ Verify X-Hub-Signature-256 (HMAC-SHA256)
  ├─ Return 200 OK immediately (Meta requirement)
  ├─ Fan-out: resolve all Targenix users connected to that page_id
  └─ For each user → saveIncomingLead (leads table, status: PENDING)
        │
        ▼
dispatchLeadProcessing
  ├─ Redis available → push BullMQ job (lead-processing queue)
  └─ No Redis → setImmediate in-process (dev / degraded mode)
        │
        ▼
processLead (worker process OR in-process)
  ├─ Resolve encrypted Facebook access token
  ├─ Fetch full field_data from Graph API
  ├─ Denormalize: fullName, phone, email, extraFields, ad attribution
  ├─ Update lead: dataStatus = ENRICHED (or ERROR)
  ├─ Create one Order per active LEAD_ROUTING integration
  ├─ Send to destinations:
  │   ├─ Telegram: HTML-formatted message → telegramChatId
  │   └─ HTTP endpoint: POST/GET with variable injection + retry policy
  └─ Aggregate order statuses → update lead.deliveryStatus
        │
        ▼
Worker schedulers (hourly)
  ├─ Retry Graph errors (re-dispatch leads with dataStatus=ERROR)
  ├─ Retry stuck PENDING leads (>10 min threshold)
  ├─ Retry failed Orders (max 3 attempts, 1h spacing)
  ├─ Log retention (purge old app_logs per policy)
  ├─ Facebook forms cache refresh
  └─ Ad accounts / campaigns / insights sync
```

---

## 🧩 Features

All features listed below are **verified from the codebase**.

### Lead Ingestion
- **Facebook & Instagram Lead Ads webhook** — real-time `POST /api/webhooks/facebook` with HMAC-SHA256 signature verification
- **Meta hub challenge verification** — `GET /api/webhooks/facebook` for initial Meta subscription setup
- **Multi-tenant fan-out** — a single Facebook Page can be connected to multiple Targenix accounts; all receive the lead independently
- **Webhook event log** — every raw payload stored in `webhook_events` for audit and replay

### Lead Processing
- **Graph API enrichment** — full `field_data` array fetched per lead; phone, name, email, and extra fields extracted
- **Ad attribution** — `campaignId`, `adsetId`, `adId` denormalized from Graph payload
- **`dataStatus` / `deliveryStatus` pipeline** — PENDING → ENRICHED / ERROR; PENDING → PROCESSING → SUCCESS / FAILED / PARTIAL
- **Manual poll from form** — `leads.pollFacebookForm` tRPC procedure lets users import past leads from a connected form
- **Lead resync** — re-fetch Graph data for existing leads via `leads.resync`

### Destinations
- **Telegram delivery** — HTML-formatted lead summaries sent to linked bot chats (DELIVERY type); SYSTEM chat reserved for alerts
- **HTTP destinations (Target Websites)** — flexible POST / GET with JSON, `application/x-www-form-urlencoded`, or `multipart/form-data`; variable injection (`{{name}}`, `{{phone}}`, `{{email}}`, `{{lead_id}}`, custom fields); configurable success rules (`http_2xx`, `json_field`, `ok_true`)
- **Admin-managed destination templates** — reusable endpoint definitions (URL, method, content type, body fields) so users configure only their secrets and offer IDs
- **Test lead delivery** — `targetWebsites.testDelivery` sends a synthetic lead to verify a destination before going live

### Retry & Reliability
- **BullMQ queue** — durable async processing when `REDIS_URL` is configured; 3 auto-retry attempts with exponential backoff
- **Order retry scheduler** — hourly, max 3 attempts with 1-hour spacing between attempts; independent of BullMQ
- **Graph error retry** — hourly re-dispatch for leads that failed enrichment (up to 500 at a time)
- **Stuck lead detection** — leads stuck in PENDING >10 minutes are automatically re-dispatched

### Authentication
- **Email / password** — register, login, logout with `bcryptjs` (12 rounds) + `jose` JWT session cookie (30-day TTL, HTTP-only, Secure)
- **Facebook Login** — OAuth authorization code flow as an alternative sign-in path
- **Password reset** — SMTP email with time-limited token
- **Role system** — `user` and `admin` roles; admin-gated pages and tRPC procedures

### Facebook Account Management
- **User-level Facebook accounts** — encrypted long-lived access tokens stored per account
- **Page-level connections** — subscribe the Meta app to a page to receive its leads
- **Forms cache** — hourly refresh of form metadata per connected page
- **Facebook OAuth flows** — account connect and page connect via server-side `/api/auth/facebook/...` routes

### Analytics & Observability
- **Ad account drill-down** — Facebook ad accounts, campaigns, ad sets, and performance insights synced hourly
- **Campaign insights** — spend, impressions, clicks, leads count, CTR, CPL, conversion rate
- **Per-destination analytics** — delivery success rates by destination
- **Structured logs** — `app_logs` table with level (INFO/WARN/ERROR/DEBUG), category, eventType, duration, meta JSON; retention policy (48h USER logs, 30d SYSTEM logs)
- **Health endpoint** — `GET /api/health` returns DB status, last webhook timestamp, dispatch mode, uptime
- **SSE admin stream** — real-time webhook event feed at `GET /api/webhooks/events/stream` (admin only)

### Dashboard & UI
- **Leads list** — paginated, searchable, filterable by status / page / form / platform (fb | ig)
- **Lead detail** — full payload, orders list, delivery status breakdown
- **Integrations wizard** — step-by-step `LEAD_ROUTING` creation (page + form → destination)
- **Connections manager** — add / remove Facebook pages, sync forms
- **Telegram settings** — link chats, set delivery mode, set default delivery chat
- **Admin tools** — global leads browser, backfill operations, destination template management, structured logs viewer
- **Internationalisation** — `en`, `ru`, `uz` locale files

### Not Implemented
- **Google Sheets** — No Sheets API integration exists in this repository
- **Zapier / Make-style visual workflow builder** — routing is data-driven (page + form → destination), not a multi-step canvas
- **In-app AI chat** — LLM dependencies exist (`@ai-sdk/openai`, `ai`) but chat routes are not registered in the production server entry

---

## 🏗️ Architecture

### Repository Layout

```
targenix.uz/
├── server/                   # Node.js backend
│   ├── _core/                # Express app bootstrap, middleware, context helpers
│   ├── routers/              # tRPC routers (auth, leads, integrations, etc.)
│   ├── services/             # Business logic (lead pipeline, Facebook, Telegram, email)
│   ├── webhooks/             # Facebook & Telegram webhook handlers + SSE
│   ├── queues/               # BullMQ queue definition + Redis connection
│   ├── workers/              # Worker entry + background schedulers
│   ├── routes/               # Express REST routes (OAuth flows)
│   ├── lib/                  # Shared utilities (URL safety, retry policies)
│   ├── db.ts                 # Drizzle + mysql2 connection
│   ├── index.ts              # Web server entry point
│   └── worker.ts             # Worker process entry point
├── client/                   # React 19 SPA
│   └── src/
│       ├── pages/            # 31 pages (dashboard, auth, settings, admin)
│       ├── components/       # Shared UI components (Radix-based)
│       ├── contexts/         # Theme + locale providers
│       ├── hooks/            # Custom React hooks
│       └── locales/          # i18n JSON (en, ru, uz)
├── drizzle/
│   ├── schema.ts             # 23-table MySQL schema
│   └── migrations/           # Drizzle Kit migration files
├── shared/                   # Code shared between server and client
│   ├── types.ts              # Re-exported schema types
│   └── const.ts              # Session cookie names, shared constants
├── scripts/                  # One-off migration and backfill scripts
├── tooling/                  # DB inspection and maintenance utilities
├── package.json              # pnpm workspace root
├── drizzle.config.ts         # Drizzle Kit config (MySQL dialect)
├── vite.config.ts            # Vite config (frontend build + dev proxy)
├── vitest.config.ts          # Vitest test runner config
└── railway.toml              # Railway deployment config (web + worker services)
```

### Backend

The backend is a single **Express** application with **tRPC** for typed API procedures and plain REST routes for webhooks and OAuth callbacks.

- **`server/_core/index.ts`** — bootstraps Express: Helmet + CSP, rate limiters, raw body capture (required for HMAC verification), JSON parser, static file serving, tRPC adapter, webhook mounts
- **`server/routers.ts`** — root tRPC router merging all domain routers
- **`server/services/`** — lead pipeline (`leadService`, `leadDispatch`), Graph API client, Telegram send/format, affiliate HTTP delivery, schedulers, email sender
- **`server/workers/`** — BullMQ job consumer (concurrency 5) + five hourly schedulers; runs as a **separate process** (`dist/worker.js`) to prevent duplicate cron execution when the web tier scales horizontally

### Frontend

A **React 19** SPA bundled by **Vite 7**, served as static files from `dist/public/` in production.

- **Wouter** — lightweight client-side router
- **tRPC React Query** — typed server state management; auto-generated types from server routers
- **Radix UI primitives** — accessible headless components (24+ primitives)
- **Tailwind CSS 4** — utility-first styling

### Database

**MySQL** accessed via **Drizzle ORM**. 23 tables across logical domains:

| Domain | Tables |
|--------|--------|
| Users & Auth | `users`, `password_reset_tokens`, `facebook_oauth_states` |
| Facebook | `facebook_accounts`, `facebook_connections`, `facebook_forms` |
| Lead Pipeline | `leads`, `orders`, `integrations` |
| Destinations | `target_websites`, `destination_templates` |
| Telegram | `telegram_chats`, `telegram_pending_chats` |
| Observability | `webhook_events`, `app_logs` |
| Ad Data Cache | `ad_accounts_cache`, `campaigns_cache`, `ad_sets_cache`, `campaign_insights_cache` |

### Async Processing

```
Web process (dist/index.js)
  └─ Receives webhook
  └─ Saves lead row
  └─ IF REDIS_URL → push BullMQ job
     ELSE → setImmediate in-process (not durable)

Worker process (dist/worker.js)
  └─ BullMQ consumer: processLead (concurrency 5, 3 auto-retries)
  └─ Hourly scheduler: retryGraphErrors
  └─ Hourly scheduler: retryStuckPending
  └─ Hourly scheduler: retryFailedOrders
  └─ Hourly scheduler: logRetention
  └─ Hourly scheduler: refreshFacebookForms
  └─ Hourly scheduler: syncAdAccounts
```

---

## 🔌 Integrations

### Facebook Lead Ads

**How it connects:**
1. User authenticates with Facebook in the dashboard (OAuth → long-lived token stored AES-256-CBC encrypted)
2. User selects a Page to connect; server calls Graph API to subscribe the Meta app to the page's `leadgen` topic
3. Meta sends `leadgen` webhook events to `POST /api/webhooks/facebook`

**Webhook security:**
- `GET` verification: returns `hub.challenge` when `hub.verify_token` matches `FACEBOOK_VERIFY_TOKEN`
- `POST` verification: HMAC-SHA256 of raw body against `FACEBOOK_APP_SECRET`; requests without a valid signature are rejected (when `FACEBOOK_APP_SECRET` is configured)

**Graph API usage:**
- `/{leadgen_id}?fields=field_data,...` — fetch full lead payload
- `/{page_id}/leadgen_forms` — list forms per page (hourly cache refresh)
- `/{page_id}/subscribed_apps` — subscribe/unsubscribe app
- Marketing API: ad accounts, campaigns, ad sets, insights (hourly sync)

**Token management:**
- All Facebook access tokens are AES-256-CBC encrypted before storage using `ENCRYPTION_KEY`
- Token resolution priority: LEAD_ROUTING integration config → `facebook_accounts` → `facebook_connections`

---

### Telegram

**How it connects:**
1. User opens the Telegram settings page in the dashboard
2. Server generates a one-time `/start <token>` link
3. User clicks the link and starts the bot; bot receives `/start <token>`, links the chat to the user's account
4. Chat is saved as type `SYSTEM` (1:1 with bot) or `DELIVERY` (group/channel)
5. User assigns a delivery chat to a LEAD_ROUTING integration

**Lead notifications:**
- HTML-formatted messages built in `telegramFormatter.ts`
- Includes: lead fields (name, phone, email, extras), source (page, form, platform), ad attribution, delivery attempt info
- Sent only to `DELIVERY`-type chats, never to `SYSTEM` chat

**Bot registration:**
- On server start, `registerTelegramWebhook(APP_URL)` sets the bot's webhook URL at the Telegram API to `{APP_URL}/api/telegram/webhook`
- Optional `TELEGRAM_WEBHOOK_SECRET` for request validation

---

### HTTP Destinations (Affiliate / Custom / Templates)

**How it works:**
1. User creates a Target Website with a URL, HTTP method, content type, and field mapping
2. Optionally based on an admin-managed destination template (reusable endpoint definition)
3. When a lead matches a LEAD_ROUTING integration, an `orders` row is created and the HTTP call is dispatched

**Variable injection in URL, headers, and body:**
- `{{name}}`, `{{phone}}`, `{{email}}`, `{{lead_id}}`, `{{page_id}}`, `{{form_id}}`
- Any extra field from the lead's `extraFields` JSON

**Success rules:**
- `http_2xx` — HTTP status 200–299 (default)
- `json_field` — check a specific field in the JSON response equals an expected value
- `ok_true` — legacy: `response.ok === true`

**Retry policy:**
- Max 3 attempts per order
- 1-hour gap between retries (scheduled by worker)
- Final failure after 3 attempts → order status `FAILED`, lead `deliveryStatus` updated

---

### Google Sheets

**Not implemented.** No Google Sheets API integration, OAuth, or sync logic exists in this codebase.

---

## 🛠️ Tech Stack

### Backend

| Category | Technology |
|----------|------------|
| Runtime | Node.js ≥ 22 |
| Framework | Express 4.21 |
| API layer | tRPC 11.6 |
| Validation | Zod 4.1 |
| ORM | Drizzle ORM 0.44 |
| Database | MySQL (mysql2 3.15) |
| Job queue | BullMQ 5.70 + ioredis 5.10 |
| Auth | jose 6.1 (JWT), bcryptjs 3.0 |
| HTTP client | axios 1.13 |
| Email | nodemailer 8.0 |
| Telegram | node-telegram-bot-api 0.67 |
| Security | Helmet 8.1, express-rate-limit 8.3 |
| Utilities | nanoid 5.1, date-fns 4.1 |

### Frontend

| Category | Technology |
|----------|------------|
| Framework | React 19.2 |
| Build tool | Vite 7.1 |
| Router | Wouter 3.7 |
| Server state | TanStack Query 5.90 + tRPC React Query |
| Forms | react-hook-form 7.64 + @hookform/resolvers |
| UI primitives | Radix UI (24+ primitives) |
| Styling | Tailwind CSS 4.1, class-variance-authority |
| Charts | Recharts 2.15 |
| Animations | Framer Motion 12.23 |
| Notifications | Sonner 2.0 |
| Icons | Lucide React 0.453 |

### Tooling

| Category | Technology |
|----------|------------|
| Language | TypeScript 5.9 |
| Server bundler | esbuild 0.25 |
| Dev server | tsx 4.19 (ts-node alternative) |
| Test runner | Vitest |
| Package manager | pnpm |
| DB migrations | Drizzle Kit |
| Deployment | Railway (railway.toml) |

---

## 📦 Installation

### Prerequisites

- Node.js 22+
- pnpm (`npm install -g pnpm`)
- MySQL database (local or hosted)
- Redis (optional — required for durable production queue)

### Steps

```bash
# 1. Clone the repository
git clone <repository-url>
cd targenix.uz

# 2. Install dependencies
pnpm install

# 3. Create environment file
cp .env.example .env   # if .env.example exists; otherwise create .env manually
# Edit .env with your values (see Environment Variables section)

# 4. Run database migrations
pnpm db:push

# 5. Development mode (web server + Vite HMR on a single port)
pnpm dev
```

### Production

```bash
# Build frontend SPA + server bundle + worker bundle
pnpm build

# Start web server (serves API + static frontend)
pnpm start

# Start worker process (required for durable queue + background schedulers)
pnpm start:worker
```

Run both `pnpm start` and `pnpm start:worker` as separate processes in production. Use **PM2**, **systemd**, or Railway's multi-service config (`railway.toml` already defines both).

### Railway Deployment

The repository includes `railway.toml` with two services pre-configured:

| Service | Command |
|---------|---------|
| Web | `NODE_ENV=production node dist/index.js` |
| Worker | `NODE_ENV=production node dist/worker.js` |

Set all required environment variables in Railway's Variables panel and deploy.

---

## 🔐 Environment Variables

### Required (server startup will fail without these)

| Variable | Description |
|----------|-------------|
| `APP_URL` | Full public URL, e.g. `https://app.targenix.uz`. Must use `https://` in production. Used for OAuth redirects, Telegram webhook registration, and email links. |
| `DATABASE_URL` | MySQL connection string. Also accepts `MYSQL_URL` or `MYSQL_PUBLIC_URL` (Railway naming). At least one must be set. |
| `FACEBOOK_APP_SECRET` | Meta app secret. Enables HMAC-SHA256 verification on incoming webhooks. |
| `FACEBOOK_VERIFY_TOKEN` | Arbitrary token configured in Meta's Webhooks UI to verify hub challenge requests. |
| `ENCRYPTION_KEY` | Exactly **32 characters**. AES-256-CBC key for encrypting stored Facebook tokens. Changing this invalidates all existing encrypted tokens. |
| `JWT_SECRET` | At least **32 characters**. Signs session JWT cookies. |

### Required for Production Reliability

| Variable | Description |
|----------|-------------|
| `REDIS_URL` | Redis connection string. Enables BullMQ durable queue. Without this, leads are processed in-process only (not durable across restarts). The worker process exits if this is not set. |

### Facebook

| Variable | Description |
|----------|-------------|
| `FACEBOOK_APP_ID` | Meta App ID, used server-side for OAuth token exchange. |
| `VITE_FACEBOOK_APP_ID` | Same value, injected into the client build for the Facebook JS SDK (`FB.init`). Must be set at build time. |

### Telegram

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API token. Required for Telegram delivery destination. |
| `TELEGRAM_BOT_USERNAME` | Bot username (without `@`). Optional; defaults to `Targenixbot`. |
| `TELEGRAM_WEBHOOK_SECRET` | Optional secret token for validating incoming Telegram webhook requests. |

### Email (Password Reset)

| Variable | Description |
|----------|-------------|
| `SMTP_HOST` | SMTP server hostname. |
| `SMTP_PORT` | SMTP port (e.g. `587` for STARTTLS, `465` for SSL). |
| `SMTP_USER` | SMTP username / email address. |
| `SMTP_PASS` | SMTP password. |
| `SMTP_FROM` | From address for outbound emails. Falls back to `SMTP_USER` if not set. |

### Optional / Ancillary

| Variable | Description |
|----------|-------------|
| `PORT` | HTTP listen port. Defaults to `3000`. |
| `NODE_ENV` | `development` or `production`. Affects Vite mode, CSP assumptions, cookie security flags. |
| `OWNER_OPEN_ID` | OpenID of the initial admin user. Used by env helpers for owner-scoped behavior. |
| `VITE_ANALYTICS_ENDPOINT` | Umami analytics script endpoint. Injected into `client/index.html` at build time. |
| `VITE_ANALYTICS_WEBSITE_ID` | Umami website ID. |
| `BUILT_IN_FORGE_API_URL` | Optional internal API URL for the built-in forge/map integration. |
| `BUILT_IN_FORGE_API_KEY` | API key for the forge integration. |
| `VITE_FRONTEND_FORGE_API_URL` | Client-side forge API URL (injected at Vite build time). |
| `VITE_FRONTEND_FORGE_API_KEY` | Client-side forge API key. |

> **Note:** All `VITE_*` variables must be present **at build time** (`pnpm build`). They are statically embedded in the frontend bundle by Vite and cannot be changed at runtime.

---

## 📡 API Endpoints

### REST (Express)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/health` | None | System health: DB status, last webhook time, dispatch mode, uptime |
| `GET` | `/api/webhooks/facebook` | None | Meta hub challenge verification |
| `POST` | `/api/webhooks/facebook` | HMAC | Facebook leadgen webhook ingestion (rate limit: 300 req/min) |
| `GET` | `/api/webhooks/events/stream` | Admin | SSE stream of real-time webhook events |
| `POST` | `/api/telegram/webhook` | Secret | Telegram bot update handler (rate limit: 300 req/min) |
| `GET` | `/api/auth/facebook/start` | Session | Redirect to Facebook login OAuth |
| `GET` | `/api/auth/facebook/callback` | None | Facebook login OAuth callback |
| `GET` | `/api/auth/facebook/connect-start` | Session | Start Facebook page connection OAuth |
| `GET` | `/api/auth/facebook/connect-callback` | None | Page connection OAuth callback |

### tRPC (`/api/trpc/*`)

All procedures use tRPC's batched HTTP transport. Types are inferred from router definitions.

| Namespace | Key Procedures |
|-----------|----------------|
| `auth` | `register`, `login`, `logout`, `me`, `forgotPassword`, `resetPassword`, `facebookLogin`, `deleteAccount` |
| `leads` | `list` (paginated + filtered), `getById`, `getStats`, `getCount`, `resync`, `pollFacebookForm`, `retryLead`, `retryAllFailed` |
| `integrations` | `list`, `create` (LEAD_ROUTING), `update`, `delete`, `testLead` |
| `facebookAccounts` | `list`, `connect`, `disconnect`, `getPages` |
| `targetWebsites` | `list`, `create`, `update`, `delete`, `testDelivery` |
| `telegram` | `connectSystemChat`, `listChats`, `disconnectChat`, `updateDeliveryMode`, `setDefaultDeliveryChat` |
| `webhook` | Admin stats, recent events |
| `logs` | Paginated structured log query (admin) |
| `adminLeads` | Global leads browser (admin) |
| `adminBackfill` | Bulk resync operations (admin) |
| `adminTemplates` | Destination template CRUD (admin) |
| `adAnalytics` | Ad accounts, campaigns, ad sets, campaign insights |
| `system` | System-level configuration queries |

---

## 🧪 Testing

### Run Unit Tests

```bash
pnpm test
# or equivalently
pnpm exec vitest run
```

### Test Files

| File | What it covers |
|------|----------------|
| `server/affiliateService.test.ts` | Variable injection, success rule evaluation, HTTP delivery |
| `server/auth.logout.test.ts` | Session cookie clearing on logout |
| `server/encryption.test.ts` | AES-256-CBC token encrypt / decrypt round-trip |
| `server/httpLogging.test.ts` | HTTP request / response structured logging |
| `server/logRetentionScheduler.test.ts` | Log cleanup policy (USER 48h, SYSTEM 30d) |
| `server/multiTenantIsolation.test.ts` | userId-scoped query isolation |
| `server/publicUser.test.ts` | Unauthenticated request context handling |
| `server/retryScheduler.test.ts` | Order retry logic, stuck lead detection, Graph error retry |
| `server/telegramFormatter.test.ts` | HTML message formatting for lead notifications |
| `server/webhook.signature.test.ts` | HMAC-SHA256 webhook signature verification |

> There are no E2E or browser tests in this repository.

### Manual Integration Testing

1. Set `FACEBOOK_APP_SECRET` and `FACEBOOK_VERIFY_TOKEN` in `.env`
2. Configure Meta's webhook to `https://<your-host>/api/webhooks/facebook`
3. Connect a Facebook Page in the dashboard (`/connections`)
4. Create a LEAD_ROUTING integration (`/integrations/new-routing`) pointing to a Telegram chat or HTTP destination
5. Use Meta's **"Send Test Lead"** button in the Lead Ads form setup, or run `integrations.testLead` from the Integrations UI
6. Verify rows appear in `leads` and `orders` tables and the destination receives the payload

---

## 📊 Current Status

| Component | Status | Notes |
|-----------|--------|-------|
| Facebook webhook ingestion | Working | HMAC verification, multi-tenant fan-out, event logging |
| Graph API enrichment | Working | Full field_data, ad attribution, platform detection |
| Lead pipeline (dataStatus / deliveryStatus) | Working | PENDING → ENRICHED / ERROR; order-level tracking |
| Telegram delivery | Working | Requires `TELEGRAM_BOT_TOKEN`; HTML-formatted messages |
| HTTP destinations (affiliate / custom) | Working | Variable injection, retry policy, success rules |
| Admin destination templates | Working | Admin creates; users select and configure |
| Facebook account & page OAuth | Working | Long-lived encrypted tokens; page subscription |
| Email authentication | Working | bcrypt + JWT session cookies |
| Facebook Login | Working | OAuth code flow; upserts user via `facebook:{id}` openId |
| Password reset via email | Working | Requires SMTP environment variables |
| BullMQ durable queue | Working (optional) | Requires `REDIS_URL`; degrades gracefully without it |
| Worker background schedulers | Working | Requires separate `pnpm start:worker` process |
| Ad account / campaign sync | Working | Hourly sync from Facebook Marketing API |
| Dashboard analytics | Working | Lead counts, delivery rates, ad performance |
| i18n (en / ru / uz) | Working | Locale JSON files; React context provider |
| Admin tools (logs, backfill, templates) | Working | Role-gated to `admin` users |
| Google Sheets integration | **Not implemented** | No Sheets API code exists |
| In-app AI chat | **Not exposed** | Dependencies present; routes not registered |
| E2E / browser test suite | **Not implemented** | Unit tests only |

---

## 🚧 Roadmap

The following are potential next steps — not committed deliverables:

- **Google Sheets destination** — export leads to a Sheets spreadsheet via OAuth-authenticated Google Sheets API with batching support
- **Additional destination types** — Slack, email, Airtable, custom webhooks with richer mapping UI
- **Multi-step workflow automation** — visual canvas for chaining actions beyond a single page→form→destination rule
- **Webhook replay / dead-letter UI** — operator UI to inspect, replay, or discard failed webhook events from `webhook_events` table
- **E2E test suite** — Playwright tests against a staging Meta test app and a seeded database
- **OpenTelemetry** — standardised traces and metrics across web and worker processes (currently: health endpoint + structured logs + SSE)
- **Billing / subscription management** — per-user plan limits on leads per month, integrations, and destinations
- **Lead deduplication** — configurable rules to suppress duplicate leads within a time window

---

## 🤝 Contributing

1. Fork the repository and create a feature branch from `main`
2. Follow the existing TypeScript and tRPC patterns; all new API procedures should go through the router hierarchy in `server/routers/`
3. Maintain **multi-tenant isolation** — every query must filter by `userId`; no cross-tenant data leaks
4. Do not bypass webhook signature verification in new code paths
5. Run checks before opening a PR:
   ```bash
   pnpm check   # TypeScript type-check
   pnpm test    # Vitest unit tests
   ```
6. Keep PRs focused; separate refactors from feature additions

---

## 📄 License

**MIT** — see `"license": "MIT"` in `package.json`.
