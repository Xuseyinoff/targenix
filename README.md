# Targenix.uz — Facebook Lead Ads Integration Platform

A production-ready full-stack platform that captures Facebook Lead Ads in real time via webhook, enriches them through the Facebook Graph API, and forwards them to Telegram channels and affiliate endpoints. Built with React 19, Express 4, tRPC 11, Drizzle ORM, and MySQL.

**Live demo:** [leadadsweb-8bpfwfmt.manus.space](https://leadadsweb-8bpfwfmt.manus.space)

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Environment Variables](#environment-variables)
- [Local Development](#local-development)
- [Database Setup](#database-setup)
- [Deployment Guide](#deployment-guide)
  - [Railway](#deploy-to-railway)
  - [Render](#deploy-to-render)
  - [VPS (Ubuntu)](#deploy-to-vps-ubuntu)
- [Facebook Webhook Configuration](#facebook-webhook-configuration)
- [API Endpoints](#api-endpoints)
- [Project Structure](#project-structure)
- [Running Tests](#running-tests)

---

## Architecture Overview

```
Facebook Lead Ads
       │
       │  POST /api/webhooks/facebook
       ▼
┌─────────────────────────────────────┐
│  Express Server (Node.js 22)        │
│  1. Verify X-Hub-Signature-256      │
│  2. Return 200 OK immediately       │
│  3. setImmediate → process lead     │
└──────────────┬──────────────────────┘
               │
       ┌───────▼────────┐
       │  MySQL Database │  ← Drizzle ORM
       │  - leads        │
       │  - webhook_events│
       │  - integrations │
       │  - fb_connections│
       └───────┬─────────┘
               │
    ┌──────────▼──────────┐
    │  Facebook Graph API  │  GET /v19.0/{leadgen_id}
    │  (fetch full data)   │  → fullName, phone, email
    └──────────┬───────────┘
               │
    ┌──────────▼──────────┐
    │  Integrations        │
    │  - Telegram Bot      │  → formatted lead message
    │  - Affiliate API     │  → order payload + retry
    └─────────────────────┘
```

**Key design decision:** The server responds `200 OK` to Facebook within ~350ms, then processes the lead asynchronously via `setImmediate`. This prevents Facebook from retrying due to slow responses. Redis/BullMQ is intentionally not used — synchronous in-process handling is sufficient and removes the Redis infrastructure dependency.

---

## Features

- **Real-time webhook** — receives Facebook `leadgen` events with HMAC-SHA256 signature verification
- **Graph API enrichment** — fetches full lead data (name, phone, email) using stored Page Access Tokens
- **Admin dashboard** — React SPA with leads table, webhook health monitor, integrations manager, and FB connections
- **Live event stream** — Server-Sent Events (SSE) on the Webhook Health page; new events appear without page refresh
- **Facebook polling** — manual "Sync from Facebook" to pull leads directly from a Form ID via Graph API
- **Telegram integration** — sends formatted lead notifications to any bot/channel
- **Affiliate integration** — posts lead data to configurable endpoints with exponential-backoff retry (up to 3 attempts)
- **AES-256-CBC encryption** — all stored Page Access Tokens are encrypted at rest
- **No Redis required** — runs on any Node.js host without additional infrastructure

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Tailwind CSS 4, shadcn/ui, tRPC client |
| Backend | Node.js 22, Express 4, tRPC 11 |
| Database | MySQL / TiDB (via Drizzle ORM) |
| Auth | Manus OAuth (JWT session cookies) |
| Build | Vite 7 (frontend), esbuild (server bundle) |
| Testing | Vitest |

---

## Environment Variables

Create a `.env` file at the project root (never commit this file). Copy `.env.example` as a starting point.

```env
# ── Database ──────────────────────────────────────────────────────────────────
# MySQL connection string. Supports TiDB, PlanetScale, Railway MySQL, etc.
DATABASE_URL=mysql://user:password@host:3306/dbname

# ── Application ───────────────────────────────────────────────────────────────
# Full public URL of your deployed app (no trailing slash).
# Used to build the webhook callback URL shown in the dashboard.
APP_URL=https://your-app.railway.app

# ── Facebook ──────────────────────────────────────────────────────────────────
# Your Facebook App's App Secret (App Dashboard → Settings → Basic).
# Used to verify X-Hub-Signature-256 on incoming webhook requests.
# If left empty, signature verification is skipped (development only).
FACEBOOK_APP_SECRET=your_app_secret_here

# A secret string you choose freely. Must exactly match what you enter in the
# Facebook Developer Console when configuring the webhook callback URL.
FACEBOOK_VERIFY_TOKEN=your_chosen_verify_token

# ── Encryption ────────────────────────────────────────────────────────────────
# 32-character (256-bit) random string for AES-256-CBC encryption of
# Facebook Page Access Tokens stored in the database.
# Generate with: openssl rand -hex 16
ENCRYPTION_KEY=your_32_char_random_string_here

# ── Auth (Manus OAuth) ────────────────────────────────────────────────────────
# Required for the login/logout flow in the admin dashboard.
JWT_SECRET=your_jwt_secret_here
VITE_APP_ID=your_manus_app_id
OAUTH_SERVER_URL=https://api.manus.im
VITE_OAUTH_PORTAL_URL=https://manus.im

# ── Owner info ────────────────────────────────────────────────────────────────
# The first user with this openId is automatically promoted to admin.
OWNER_OPEN_ID=your_manus_open_id
OWNER_NAME=Your Name

# ── Manus built-in APIs (optional) ───────────────────────────────────────────
BUILT_IN_FORGE_API_URL=
BUILT_IN_FORGE_API_KEY=
VITE_FRONTEND_FORGE_API_KEY=
VITE_FRONTEND_FORGE_API_URL=
```

**Variable reference:**

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | MySQL/TiDB connection string |
| `APP_URL` | Yes | Public HTTPS URL, no trailing slash |
| `FACEBOOK_APP_SECRET` | Recommended | Skip = no signature verification |
| `FACEBOOK_VERIFY_TOKEN` | Yes | Must match Facebook Console entry |
| `ENCRYPTION_KEY` | Yes | Exactly 32 characters |
| `JWT_SECRET` | Yes | Any long random string |
| `VITE_APP_ID` | Yes | Manus OAuth App ID |
| `OAUTH_SERVER_URL` | Yes | `https://api.manus.im` |
| `VITE_OAUTH_PORTAL_URL` | Yes | `https://manus.im` |
| `OWNER_OPEN_ID` | Yes | Your Manus user openId |

> **Important:** `ENCRYPTION_KEY` must be exactly 32 characters. Changing it after tokens are stored will break decryption of all saved Page Access Tokens. Rotate carefully.

---

## Local Development

```bash
# 1. Clone the repository
git clone https://github.com/namas2003/Leadflow.git
cd Leadflow

# 2. Install dependencies (requires pnpm ≥ 10)
pnpm install

# 3. Copy and fill in environment variables
cp .env.example .env
# Edit .env with your values

# 4. Push database schema (creates all tables)
pnpm db:push

# 5. Start the development server (hot-reload on both frontend and backend)
pnpm dev
```

The app runs at `http://localhost:3000`. Vite proxies frontend requests to the Express backend — both are served from the same port.

To test the webhook locally, use a tunnel tool such as [ngrok](https://ngrok.com):

```bash
ngrok http 3000
# Use the https://xxxx.ngrok.io URL as your Facebook callback URL
```

---

## Database Setup

This project uses **Drizzle ORM** with a **MySQL** (or TiDB-compatible) database. No manual SQL is required.

### Tables

| Table | Purpose |
|---|---|
| `users` | Manus OAuth user accounts |
| `leads` | Captured Facebook leads (status: PENDING → RECEIVED / FAILED) |
| `webhook_events` | Log of all incoming webhook POST requests with signature status |
| `integrations` | Telegram and Affiliate integration configurations |
| `facebook_connections` | Facebook Page ID + AES-256-encrypted Access Token pairs |
| `orders` | Delivery attempt records per integration (PENDING → SENT / FAILED) |

### Applying migrations

```bash
pnpm db:push
```

This runs `drizzle-kit generate && drizzle-kit migrate`. It is idempotent — safe to run on every deploy. Drizzle tracks which migrations have been applied.

---

## Deployment Guide

### Deploy to Railway

Railway is the closest match to the Manus.space environment (Node.js + MySQL on the same platform).

**Step 1 — Create a new project**

1. Go to [railway.app](https://railway.app) → **New Project**.
2. Click **"Add Service" → "GitHub Repo"** and select this repository.
3. Click **"Add Service" → "Database" → "MySQL"** to provision a MySQL instance.

**Step 2 — Set environment variables**

In the Railway service → **Variables**, add all variables from the table above. For `DATABASE_URL`, copy the connection string from your MySQL service's **Connect** tab (use the internal URL for services in the same project).

**Step 3 — Configure build and start commands**

In the service settings, set:

| Setting | Value |
|---|---|
| Build Command | `pnpm install && pnpm build` |
| Start Command | `pnpm db:push && pnpm start` |

The `pnpm db:push` in the start command ensures migrations run automatically on every deploy before the server starts.

**Step 4 — Set `APP_URL`**

After the first deploy, Railway assigns a public URL (e.g., `https://leadflow-production.up.railway.app`). Add this as `APP_URL` and trigger a redeploy.

**Step 5 — Configure Facebook webhook**

Use the URL shown in the **Webhook Health** page of your dashboard as the Facebook callback URL.

---

### Deploy to Render

**Step 1 — Create a Web Service**

1. Go to [render.com](https://render.com) → **New → Web Service**.
2. Connect your GitHub repository.
3. Configure:

| Setting | Value |
|---|---|
| Environment | Node |
| Build Command | `pnpm install && pnpm build` |
| Start Command | `pnpm db:push && pnpm start` |

**Step 2 — Add a MySQL database**

Render does not offer MySQL natively. Use one of:
- [PlanetScale](https://planetscale.com) — free tier, MySQL-compatible, serverless
- [TiDB Cloud](https://tidbcloud.com) — free tier, fully MySQL-compatible
- [Railway MySQL](https://railway.app) — provision separately, use the external connection string

Set `DATABASE_URL` from your chosen provider.

**Step 3 — Environment variables**

In Render service settings → **Environment**, add all required variables.

**Step 4 — Set `APP_URL`**

Render assigns a URL like `https://leadflow.onrender.com`. Set this as `APP_URL`.

> **Note on SSE:** Render's free tier may buffer Server-Sent Events. If the live stream on the Webhook Health page does not work, upgrade to a paid plan or use Railway instead.

---

### Deploy to VPS (Ubuntu)

This guide assumes Ubuntu 22.04 with a domain name pointed at your server's IP.

**Step 1 — Install system dependencies**

```bash
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# pnpm
npm install -g pnpm

# PM2 (process manager — keeps the app running after logout/reboot)
npm install -g pm2

# Nginx (reverse proxy)
sudo apt-get install -y nginx

# MySQL
sudo apt-get install -y mysql-server
sudo mysql_secure_installation
```

**Step 2 — Create the database**

```bash
sudo mysql
```

```sql
CREATE DATABASE leadflow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'leadflow'@'localhost' IDENTIFIED BY 'your_strong_password';
GRANT ALL PRIVILEGES ON leadflow.* TO 'leadflow'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

**Step 3 — Clone and configure**

```bash
git clone https://github.com/namas2003/Leadflow.git /var/www/leadflow
cd /var/www/leadflow

pnpm install

cp .env.example .env
nano .env
# Fill in all required variables. Example DATABASE_URL:
# DATABASE_URL=mysql://leadflow:your_strong_password@localhost:3306/leadflow
# APP_URL=https://your-domain.com
```

**Step 4 — Build and migrate**

```bash
pnpm build
pnpm db:push
```

**Step 5 — Start with PM2**

```bash
pm2 start "pnpm start" --name leadflow
pm2 save
pm2 startup
# Copy and run the command that pm2 prints — this enables auto-start on reboot
```

**Step 6 — Configure Nginx**

```bash
sudo nano /etc/nginx/sites-available/leadflow
```

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Required for SSE (Server-Sent Events live stream)
        proxy_buffering off;
        proxy_read_timeout 86400s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/leadflow /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# SSL with Let's Encrypt (free)
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

**Step 7 — Update `APP_URL` and restart**

```bash
# Edit .env and set APP_URL=https://your-domain.com
nano .env
pm2 restart leadflow
```

---

## Facebook Webhook Configuration

Once deployed, configure the webhook in the Facebook Developer Console:

1. Go to [developers.facebook.com](https://developers.facebook.com) → your App → **Webhooks**.
2. Select product: **Page**.
3. Click **"Add Callback URL"** and enter:
   - **Callback URL:** `https://your-domain.com/api/webhooks/facebook`
   - **Verify Token:** the value you set as `FACEBOOK_VERIFY_TOKEN`
4. Click **"Verify and Save"** — the server responds to the GET verification request automatically.
5. Subscribe to the **`leadgen`** field.
6. Go to **FB Connections** in the dashboard and add your Page ID and Long-Lived Page Access Token.

> **Development vs Live mode:** Facebook only delivers real lead webhooks to apps in **Live mode**. In Development mode, use the "Send to My Server" test button in the Webhooks dashboard (under the `leadgen` field), or use the [Lead Ads Testing Tool](https://developers.facebook.com/tools/lead-ads-testing) to generate real lead IDs that the Graph API can resolve.

### Obtaining a Long-Lived Page Access Token

```bash
# 1. Get a short-lived token from Graph API Explorer:
#    https://developers.facebook.com/tools/explorer/
#    Permissions needed: pages_read_engagement, leads_retrieval, pages_manage_metadata

# 2. Exchange for a long-lived token (~60 days):
curl "https://graph.facebook.com/oauth/access_token\
?grant_type=fb_exchange_token\
&client_id=YOUR_APP_ID\
&client_secret=YOUR_APP_SECRET\
&fb_exchange_token=SHORT_LIVED_TOKEN"
```

Enter the resulting token in the **FB Connections** page of the dashboard. It is encrypted with AES-256-CBC before being stored in the database.

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/webhooks/facebook` | Facebook hub.challenge verification |
| `POST` | `/api/webhooks/facebook` | Receive lead events from Facebook |
| `GET` | `/api/webhooks/events/stream` | SSE stream for real-time event monitoring |
| `POST` | `/api/trpc/leads.list` | Paginated lead list with search and status filter |
| `POST` | `/api/trpc/leads.getById` | Single lead with order history |
| `POST` | `/api/trpc/leads.stats` | Lead counts by status |
| `POST` | `/api/trpc/leads.pollFromForm` | Sync leads from a Facebook Form ID |
| `POST` | `/api/trpc/integrations.list` | List all integrations |
| `POST` | `/api/trpc/integrations.create` | Add Telegram or Affiliate integration |
| `POST` | `/api/trpc/integrations.toggle` | Enable/disable an integration |
| `POST` | `/api/trpc/integrations.delete` | Remove an integration |
| `POST` | `/api/trpc/facebook.listConnections` | List Facebook Page connections |
| `POST` | `/api/trpc/facebook.createConnection` | Add a Page connection |
| `POST` | `/api/trpc/facebook.deleteConnection` | Remove a Page connection |
| `POST` | `/api/trpc/facebook.webhookUrl` | Get the configured webhook callback URL |
| `POST` | `/api/trpc/webhook.recentEvents` | Last 30 webhook events from DB |
| `POST` | `/api/trpc/webhook.stats` | Webhook event counts |

---

## Project Structure

```
├── client/                       # React 19 frontend (Vite)
│   └── src/
│       ├── pages/
│       │   ├── Home.tsx              # Overview dashboard with stats
│       │   ├── Leads.tsx             # Lead list + Sync from Facebook dialog
│       │   ├── WebhookHealth.tsx     # Real-time SSE event monitor + DB log
│       │   ├── Integrations.tsx      # Telegram + Affiliate config
│       │   └── FacebookConnections.tsx
│       └── components/
│           └── DashboardLayout.tsx   # Sidebar navigation shell
│
├── server/                       # Express + tRPC backend
│   ├── _core/                    # Framework plumbing (OAuth, tRPC context, env)
│   ├── routers/
│   │   ├── leadsRouter.ts            # Lead CRUD + polling mutation
│   │   ├── integrationsRouter.ts     # Integration CRUD
│   │   ├── facebookRouter.ts         # FB connections + webhookUrl query
│   │   └── webhookRouter.ts          # Webhook stats + recent events
│   ├── services/
│   │   ├── facebookService.ts        # Graph API client + signature verification
│   │   ├── leadService.ts            # Lead save + enrichment orchestration
│   │   ├── telegramService.ts        # Telegram Bot API
│   │   └── affiliateService.ts       # Affiliate POST + exponential-backoff retry
│   ├── webhooks/
│   │   ├── facebookWebhook.ts        # GET verify + POST handler + SSE endpoint
│   │   └── sseEmitter.ts             # Server-Sent Events broadcaster (in-memory)
│   ├── encryption.ts                 # AES-256-CBC encrypt/decrypt helpers
│   ├── db.ts                         # Drizzle query helpers
│   └── routers.ts                    # Root tRPC router
│
├── drizzle/
│   ├── schema.ts                     # All table definitions (source of truth)
│   └── *.sql                         # Auto-generated migration files
│
├── shared/
│   └── const.ts                      # Shared constants (cookie name, etc.)
│
├── .gitignore
├── .env.example                      # Template for environment variables
├── drizzle.config.ts
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## Running Tests

```bash
pnpm test
```

The test suite covers:
- Webhook HMAC-SHA256 signature verification (valid and invalid signatures)
- Lead tRPC router procedures (list, stats)
- AES-256-CBC encryption and decryption round-trip
- Auth logout cookie clearing

All 9 tests pass with no external dependencies (no database or network required).

---

## Processing Flow (Step by Step)

1. Facebook POSTs `{ "object": "page", "entry": [{ "changes": [{ "field": "leadgen", "value": { "leadgen_id": "...", "page_id": "..." } }] }] }` to `/api/webhooks/facebook`.
2. Server verifies `X-Hub-Signature-256` header using `FACEBOOK_APP_SECRET`.
3. Webhook event is logged to `webhook_events` table.
4. Server returns `200 OK` immediately (Facebook requires a response within 5 seconds).
5. `setImmediate()` schedules asynchronous lead processing.
6. Lead record is inserted into `leads` table with status `PENDING`.
7. Server looks up the matching `facebook_connections` record by `page_id`.
8. Page Access Token is decrypted from AES-256-CBC storage.
9. `GET https://graph.facebook.com/v19.0/{leadgen_id}?access_token=...` fetches full lead data.
10. Lead record is updated with `fullName`, `phone`, `email` and status `RECEIVED`.
11. For each active integration: Telegram message is sent, or Affiliate endpoint is POSTed.
12. Failed deliveries are retried up to 3 times with exponential backoff (1s, 2s, 4s).
13. SSE stream broadcasts the event to any connected Webhook Health dashboard clients.

---

## License

MIT
