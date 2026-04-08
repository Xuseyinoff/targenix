# Facebook Lead Ads Webhook Integration Platform — TODO

## Phase 1: Schema & Dependencies
- [x] Update drizzle/schema.ts with facebook_connections, integrations, leads, orders, webhook_events tables
- [x] Run db:push to apply schema migrations
- [x] Install BullMQ, ioredis, axios dependencies

## Phase 2: Server-Side Core
- [x] Webhook route: GET /api/webhooks/facebook (hub.challenge verification)
- [x] Webhook route: POST /api/webhooks/facebook (receive lead, verify X-Hub-Signature-256, return 200 OK)
- [x] BullMQ queue configuration (server/queues/leadQueue.ts)
- [x] Redis connection helper (server/queues/redisConnection.ts)
- [x] BullMQ background worker (server/workers/leadWorker.ts)
- [x] Facebook Graph API service with signature verification (server/services/facebookService.ts)
- [x] Telegram notification service (server/services/telegramService.ts)
- [x] Affiliate order service with retry logic (server/services/affiliateService.ts)
- [x] Lead saving service (server/services/leadService.ts)
- [x] AES-256-CBC encryption helpers for access tokens (server/encryption.ts)
- [x] Register webhook routes and worker startup in server/_core/index.ts

## Phase 3: tRPC Routers
- [x] leads router: list, getById, stats (server/routers/leadsRouter.ts)
- [x] integrations router: list, create, update, delete, toggle (server/routers/integrationsRouter.ts)
- [x] facebookConnections router: list, create, delete, webhookUrl (server/routers/facebookRouter.ts)
- [x] webhookHealth router: recentEvents, stats (server/routers/webhookRouter.ts)
- [x] All routers registered in server/routers.ts

## Phase 4: Admin Dashboard UI
- [x] Dashboard layout with dark sidebar navigation (DashboardLayout.tsx)
- [x] Home/Overview page: stats cards (total leads, pending, failed, orders sent, integrations, webhook events)
- [x] Leads list page with status badges, search, filter, and pagination
- [x] Lead detail modal with orders display
- [x] Integrations management page (Telegram + Affiliate, create/toggle/delete)
- [x] Facebook Connections page (connect/remove pages with encrypted tokens)
- [x] Webhook health monitor page (events table, stats, config display)
- [x] All routes registered in App.tsx

## Phase 5: Quality & Docs
- [x] Environment secrets setup (FACEBOOK_APP_SECRET, FACEBOOK_VERIFY_TOKEN, TELEGRAM_BOT_TOKEN, ENCRYPTION_KEY, APP_URL)
- [x] Vitest tests for webhook signature verification (9 tests, all passing)
- [x] Vitest tests for encryption helpers
- [x] README.md with full architecture, setup instructions, and API reference

## Phase 6: Deploy
- [x] Save checkpoint
- [ ] Guide user to publish on manus.space

## Phase 6: Bug Fixes
- [x] Remove Redis/BullMQ dependency — process leads synchronously (Redis not available on Manus hosting)
- [x] Handle Facebook test webhook payload format (sample field, not entry array)
- [x] Ensure lead processing works end-to-end without Redis
- [x] Save checkpoint and re-publish

## Phase 7: Polling Feature
- [x] Add fetchLeadsFromForm() to facebookService.ts (Graph API v20.0 polling)
- [x] Add pollLeads tRPC mutation to leadsRouter (accepts formId + pageId, saves to DB)
- [x] Add "Sync from Facebook" UI button on Leads page with form/page selector
- [x] Save checkpoint and verify end-to-end polling

## Phase 8: WebhookHealth Fix
- [x] Debug WebhookHealth page — events list not showing data
- [x] Fix webhook events query in router/db
- [x] Ensure test events from Facebook Dashboard appear in the list
- [x] Save checkpoint

## Phase 9: Leads Dashboard Fix
- [x] Debug leads.list tRPC query — 83 leads in DB but not showing in UI
- [x] Fix leads display in dashboard
- [x] Save checkpoint

## Phase 10: Real-time Webhook Monitoring
- [x] Add SSE endpoint GET /api/webhooks/events/stream — broadcasts new events to connected clients
- [x] Update facebookWebhook.ts to emit SSE event on each incoming webhook
- [x] Update WebhookHealth.tsx to connect to SSE stream and show live events with visual indicator
- [x] Save checkpoint

## Phase 11: README Deployment Guide
- [ ] Write comprehensive README.md with deployment guide for Railway, Render, VPS
- [ ] Cover all environment variables, database setup, migrations, server start
- [ ] Push to GitHub main branch

## Phase 12: Fix processed=false Bug
- [x] Fix webhook_events processed status — use event ID in WHERE clause instead of JSON payload comparison
- [x] Fix insertId extraction from Drizzle insert result
- [x] Save checkpoint

## Phase 13: Bug Fixes & Improvements
- [x] Fix search/filter: pass search+status to server query (server-side filtering)
- [x] Add auto-refresh (refetchInterval 30s) to Leads and Overview pages
- [x] Add CSV export for all leads
- [x] Add "Send Test Notification" button on Integrations page
- [x] Add testNotification tRPC mutation to integrationsRouter
- [x] Upgrade Graph API version from v19.0 to v21.0
- [x] Fix TypeScript errors in Markdown.tsx, AIChatBox.tsx, ComponentShowcase.tsx
- [x] Save checkpoint and sync to GitHub

## Phase 14: Facebook Connections Improvements
- [x] Add unique constraint on pageId in facebookConnections schema (prevent duplicate pages)
- [x] Add validatePageToken() to facebookService — validates token against Graph API before saving
- [x] Add duplicate page check in createConnection router procedure
- [x] Save checkpoint and sync to GitHub

## Phase 15: Facebook Login for FB Accounts
- [x] Add server-side facebookAccounts.connectWithToken procedure (exchange short-lived → long-lived token, save account)
- [x] Load Facebook JS SDK in index.html with VITE_FACEBOOK_APP_ID
- [x] Update FacebookAccounts page: replace manual token input with "Connect with Facebook" button using FB.login() popup
- [x] Request pages_show_list, leads_retrieval, pages_read_engagement, pages_manage_ads, pages_manage_metadata permissions in FB.login() scope
- [x] Save checkpoint and sync to GitHub

## Phase 16: Privacy Policy Page
- [x] Create /privacy public page with full privacy policy content
- [x] Register route in App.tsx (no auth required)
- [x] Save checkpoint and provide URL to user

## Phase 17: Logs Page
- [ ] Add app_logs table to schema (level, category, message, meta JSON, createdAt)
- [ ] Push DB migration
- [ ] Add logEvent() helper in server/db.ts
- [ ] Instrument webhook handler with log calls (WEBHOOK_RECEIVED, WEBHOOK_VERIFIED, WEBHOOK_ERROR)
- [ ] Instrument lead service with log calls (LEAD_PROCESSING, LEAD_SUCCESS, LEAD_ERROR)
- [ ] Add HTTP request logging middleware for /api/webhooks/* routes
- [ ] Build logsRouter: list (with level/category/search filters + pagination) and clear procedures
- [ ] Register logsRouter in routers.ts
- [ ] Build /logs page: table with level badge, category, message, meta, timestamp; filters; auto-refresh 10s; clear button
- [ ] Add /logs route to App.tsx and sidebar nav
- [x] Run tests and save checkpoint

## Phase 18: Full Request & Action Logging
- [x] Add Express HTTP middleware: log every request (method, path, status, duration, IP, body preview)
- [x] Add tRPC middleware: log every procedure call (name, userId, duration, error)
- [x] Add mutation logging to facebookAccountsRouter (connect, delete) — covered by tRPC middleware
- [x] Add mutation logging to facebookRouter (createConnection, deleteConnection) — covered by tRPC middleware
- [x] Add mutation logging to integrationsRouter (create, update, delete, test) — covered by tRPC middleware
- [x] Add mutation logging to targetWebsitesRouter (create, update, delete) — covered by tRPC middleware
- [x] Save checkpoint and sync to GitHub

## Phase 19: Facebook API Logging & Noise Reduction
- [x] Add FACEBOOK category logging to all Graph API calls in facebookGraphService.ts
- [x] Add FACEBOOK category logging to fetchLeadData, fetchLeadsFromForm, validatePageToken in facebookService.ts
- [x] Suppress tRPC middleware logging for logs.* procedures
- [x] Suppress HTTP middleware logging for /api/trpc/logs.* paths
- [x] Run tests and save checkpoint

## Phase 20: Fix PENDING Status Bug
- [x] Diagnose why Facebook test leads stay in PENDING status
- [x] Fix root cause: reduce auto-refresh from 30s to 5s so RECEIVED status appears instantly
- [x] Test fix end-to-end and save checkpoint

## Phase 21: Legal Pages (EN/UZ)
- [x] Create /privacy page (EN + UZ, language toggle)
- [x] Create /terms page (EN + UZ, language toggle)
- [x] Create /data-deletion page (EN + UZ, language toggle)
- [x] Register all 3 routes in App.tsx
- [x] Save checkpoint

## Phase 22: Merge FB Connections + FB Accounts into single Connections page
- [x] Add connectAndSubscribeAll server procedure (fetch all pages + subscribe each one automatically)
- [x] Add togglePageActive procedure for enable/disable per page
- [x] Add deletePageConnection procedure
- [x] Add listConnectedPages procedure
- [x] Build new /connections page with table UI (Source, Name, Connected date, Actions)
- [x] Facebook Login button → auto-fetch all pages → auto-subscribe each → show in table
- [x] Update App.tsx: replace /fb-connections and /fb-accounts routes with /connections
- [x] Update DashboardLayout sidebar: remove FB Connections + FB Accounts, add Connections
- [x] Run tests (9 passing) and save checkpoint

## Phase 23: Email/Password Auth for Meta Reviewer
- [x] Add passwordHash column to users schema and push DB migration
- [x] Add emailAuth tRPC router: register, login procedures (bcrypt hashing, session cookie)
- [x] Build /register page with email + password + confirm password form + OAuth option
- [x] Build /login page with email + password form + OAuth option (replaces DashboardLayout login gate)
- [x] Update DashboardLayout login gate to redirect to /login instead of OAuth URL directly
- [x] Create test account: reviewer@targenix.uz / Review2024!
- [x] Run tests (9 passing) and save checkpoint

## Phase 24: Telegram Bot Integration
- [x] Add telegramChatId, telegramUsername, telegramConnectedAt, telegramConnectToken to users table
- [x] Add telegramChatId to integrations table
- [x] Push DB migration for both tables
- [x] Create Telegram bot webhook handler (POST /api/telegram/webhook)
- [x] Register bot webhook URL on server startup
- [x] Add telegramRouter: generateConnectToken, getStatus, disconnect procedures
- [x] Build Settings page with Telegram connection UI (QR/link + polling)
- [x] Add Settings to sidebar navigation
- [x] Add optional telegram_chat_id field to AFFILIATE integration create form
- [x] Update integrationsRouter.create to accept telegramChatId
- [x] Update createIntegration db helper to save telegramChatId
- [x] Add sendLeadTelegramNotification helper in leadService.ts
- [x] Send Telegram notification after AFFILIATE and LEAD_ROUTING results
- [x] Notification uses integration.telegramChatId or falls back to user.telegramChatId
- [x] All 9 tests pass, zero TypeScript errors
- [x] Save checkpoint

## Phase 26: Auto-select fields in Lead Routing Step 4
- [x] Add autoMatchField helper with multilingual patterns for full_name and phone
- [x] Apply auto-match when form fields load in Step 4 (useEffect on formFields change)
- [x] User can still override manually
- [x] Save checkpoint

## Phase 27: Scrollable List in Lead Routing Wizard Steps 2 & 3
- [x] Add ScrollableList component with top/bottom shadow indicators and scroll hint
- [x] Wrap Step 2 (pages) list with ScrollableList (shows 5 items, scrollable for 8+ pages)
- [x] Wrap Step 3 (forms) list with ScrollableList (shows 5 items, scrollable for 6+ forms)
- [x] All 9 tests pass, zero TypeScript errors
- [x] Save checkpoint and deploy

## Phase 28: Target Websites Redesign + Lead Routing Step 5 Variable Fields
- [x] Update targetWebsitesRouter: use protectedProcedure, encrypt apiKey on save, mask apiKey on list
- [x] Update affiliateService: read apiKey from templateConfig (decrypted), support variable fields (offerId/stream/streamId per template)
- [x] Update leadService: pass variableFields from integration config to affiliateService
- [x] Redesign TargetWebsites.tsx: template selector, conditional fields, masked API key, card list view
- [x] Update LeadRoutingWizard Step 5: show saved target websites as cards, show variable fields per template (sotuvchi: offer_id+stream, 100k: stream_id, custom: user-defined)
- [x] Update WizardState to store variableFields per template
- [x] Update handleSave to include variableFields in integration config
- [x] Run tests, save checkpoint and deploy

## Phase 29: Bugfix — subscribePage "Page not found in this account"
- [x] Fix subscribePage to fall back to DB-stored page token if listUserPages API fails or doesn't return the page
- [x] All 9 tests pass, zero TypeScript errors

## Phase 30: Universal Telegram Formatter
- [x] Create server/services/telegramFormatter.ts — universal, provider-agnostic HTML message builder
- [x] Smart parseApiResponse: detects status, extracts order_id/message/amount/extras from ANY API response
- [x] Replace old hardcoded sendLeadTelegramNotification with formatLeadMessage
- [x] Enrich notification with pageName, accountName, formName from DB
- [x] Add durationMs timing to AFFILIATE and LEAD_ROUTING calls
- [x] Write 27 vitest tests (12 parseApiResponse + 15 formatLeadMessage) — all pass
- [x] 36 total tests pass, zero TypeScript errors

## Phase 31: Universal Custom POST API Builder
- [x] Review existing custom template code in TargetWebsites.tsx, targetWebsitesRouter.ts, affiliateService.ts
- [x] Extend templateConfig JSON shape: contentType, headers[], bodyTemplate (JSON string), bodyFields (key-value), successCondition
- [x] Rewrite affiliateService custom handler: JSON/form-urlencoded/multipart, variable injection, success condition evaluation
- [x] Add testIntegration tRPC procedure: send sample lead, return request preview + raw response + parsed result
- [x] Redesign TargetWebsites.tsx custom form: content-type selector, dynamic body builder, headers builder, success condition, test button with result panel
- [x] Update LeadRoutingWizard Step 5: auto-detect custom variables from template body, prompt user to fill them
- [x] Write vitest tests for new variable extraction and runtime engine (22 tests)

## Phase 32: Fix Custom Variable Fields in Step 5
- [x] Fix getCustomVariables: return variableFields list from templateConfig (user-defined) + body template {{vars}} combined
- [x] Also detect bodyFields with empty value as variable names (e.g. stream with empty value → shown in Step 5)
- [x] Save checkpoint

## Phase 33: Fix testIntegration "No URL configured" bug
- [x] Fix sendAffiliateOrderByTemplate: add siteUrl param, use cfg.url || siteUrl for custom templates
- [x] Pass site.url in testIntegration procedure (targetWebsitesRouter)
- [x] Pass tw.url in leadService.ts LEAD_ROUTING handler
- [x] Fix request preview URL in testIntegration to use site.url
- [x] Save checkpoint

## Phase 34: Custom Template Variable Fields Section
- [x] Add "Variable Fields" section to TargetWebsites.tsx custom form (add/remove variable names like stream, offer_id)
- [x] variableFields saved in templateConfig JSON, loaded on edit
- [x] getCustomVariables returns variableFields first (Phase 32 already handles this)
- [x] Save checkpoint

## Phase 35: Edit Integration (Routing Rule)
- [x] updateIntegration tRPC procedure already existed in integrationsRouter
- [x] Add /integrations/edit-routing/:id route in App.tsx
- [x] LeadRoutingWizard accepts RouteComponentProps<{id?}> and pre-fills state from existing integration
- [x] Add updateIntegration mutation in wizard; handleSave uses update vs create based on isEditMode
- [x] Add Edit (Pencil) button to LEAD_ROUTING integration cards in Integrations.tsx
- [x] Run tests (58 pass), save checkpoint

## Phase 36: Retry FAILED Leads
- [x] Add retryLead tRPC procedure in leadsRouter (re-run lead processing for single FAILED lead)
- [x] Add retryAllFailed tRPC procedure in leadsRouter (re-run all FAILED leads)
- [x] Add hourly cron job in server startup via retryScheduler.ts (fires at top of each hour)
- [x] Add Retry button (RotateCcw icon) to FAILED leads in Leads.tsx UI
- [x] Add "Retry All Failed (N)" button in header when FAILED leads exist
- [x] Write vitest tests for retryScheduler (64 tests pass)
- [x] Run all tests, save checkpoint

## Phase 37: Smart Variable Chips in Integration Cards
- [x] Replace flow/offerId row with target website name (→ Name) + variableFields chips in LEAD_ROUTING cards
- [x] Chips show key: value in monospace, only non-empty values shown
- [x] targetWebsiteName already saved in config by handleSave
- [x] Save checkpoint

## Phase 38: Redesign Connections Page
- [x] Add getAccountsWithPages procedure in facebookAccountsRouter (groups pages by account)
- [x] Redesign Connections.tsx: account cards with expand/collapse, page rows inside
- [x] Save checkpoint

## Phase 39: Fix aria-describedby Warning
- [x] Fix aria-describedby warning in DialogContent (TargetWebsites.tsx)
- [x] Add DialogDescription import and component to dialog
- [x] All 64 tests pass, zero TypeScript errors

## Phase 40: Display Order Status in Leads Page
- [x] Update leadsRouter.list to fetch orders for each lead
- [x] Add Order Status column to Leads.tsx table
- [x] Show SENT/FAILED badges for each order associated with lead
- [x] All 64 tests pass, zero TypeScript errors

## Phase 41: Telegram Notification Format Upgrade
- [x] Rewrite formatLeadMessage in telegramFormatter.ts to new SaaS-style HTML structure
- [x] Exactly 2 blockquotes: client info + response block
- [x] Strong typography hierarchy (bold labels, italic section titles, code for phone/ID, underline for integration name)
- [x] All 64 tests pass

## Phase 42: Multi-tenant User Isolation Audit & Fix
- [x] Schema: all 6 business tables already have userId (facebookAccounts, facebookConnections, targetWebsites, integrations, leads, orders) - NO migration needed
- [x] Fix: webhookEvents and appLogs do NOT have userId - these are system-level tables, keep shared but restrict via role/admin
- [x] Fix: all routers using publicProcedure + resolveUserId fallback (id=1) → change to protectedProcedure
- [x] Fix: logsRouter - no userId filter on appLogs (admin-only table, acceptable)
- [x] Fix: webhookRouter - changed to protectedProcedure
- [x] Fix: leadsRouter - changed to protectedProcedure, removed resolveUserId
- [x] Fix: integrationsRouter - changed to protectedProcedure, removed resolveUserId
- [x] Fix: facebookAccountsRouter - changed to protectedProcedure, removed resolveUserId
- [x] Fix: facebookRouter - changed to protectedProcedure, removed resolveUserId
- [x] All 64 tests pass

## Phase 43: Facebook OAuth Multi-tenant Flow Verification & Fix
- [x] Audit connectAndSubscribeAll: userId saved correctly per user (protectedProcedure)
- [x] Audit webhook handler: pageId → userId lookup in facebookConnections confirmed
- [x] Fix schema: facebookConnections.pageId UNIQUE → composite (userId, pageId) unique index
- [x] Fix schema: facebookAccounts.fbUserId UNIQUE → composite (userId, fbUserId) unique index
- [x] Fix connectAndSubscribeAll: upsert by (userId, fbUserId) and (userId, pageId)
- [x] Fix webhook handler: resolveUserIdForPage returns null (no fallback to userId=1)
- [x] DB migration applied: drizzle/0009_clammy_ben_urich.sql
- [x] Write 9 multi-tenant isolation tests (all pass)
- [x] 74 total tests pass (7 test files)

## Phase 44: Landing Page & Auth Pages (Targenix.uz)
- [x] Update global CSS: dark theme, Inter font, smooth scroll
- [x] Create LandingPage.tsx: hero, how-it-works, features, trust, footer with scroll animations
- [x] Rewrite Register.tsx: full name, email, password, confirm password — dark style
- [x] Rewrite Login.tsx: match landing page dark style
- [x] Update App.tsx: / shows landing for unauth, redirects to /overview for auth
- [x] DashboardLayout: Overview path updated from / to /overview
- [x] Unauthenticated users redirected to /login by DashboardLayout
- [x] 74 tests pass (7 files)

## Phase 45: 100k.uz & Sotuvchi.com Full Config Edit
- [x] Created Sotuvchi.com (Custom) — id 60003, custom template, body fields: api_key, offer_id, stream, phone, full_name
- [x] Created 100k.uz (Custom) — id 60004, custom template, body fields: api_key (header), stream_id, customer_phone, client_full_name, facebook_lead_id, facebook_form_id
- [x] Both appear in Target Websites UI with Custom badge and full editable config
- [x] Original Sotuvchi.com (id 30001) and 100k.uz (id 30002) kept intact until user verifies new ones work

## Phase 46: Test Integration Button
- [x] Add testLead tRPC procedure in integrationsRouter: sends synthetic lead using exact config (targetWebsiteId, variableFields)
- [x] Add compact FlaskConical test button to each LEAD_ROUTING integration card
- [x] Show result in popup modal: SUCCESS (green) or FAILED (red) with server response and duration
- [x] 74 tests pass (7 files)

## Phase 47: Remove Old 100k.uz Hardcoded Template
- [x] Deleted old 100k.uz (id 30002) from target_websites table in DB
- [x] Removed build100kPayload function from affiliateService.ts
- [x] Removed 100k dispatch branch from sendAffiliateOrderByTemplate
- [x] Removed 100k from TemplateType enum (now: "sotuvchi" | "custom")
- [x] Removed 100k from TEMPLATE_DEFINITIONS
- [x] 74 tests pass (7 files)

## Phase 48: Remove Old Sotuvchi.com Hardcoded Template
- [x] Verified no integrations reference old Sotuvchi.com (id 30001) — all use id 60003
- [x] Deleted old Sotuvchi.com (id 30001) from target_websites table in DB
- [x] Removed buildSotuvchiPayload function from affiliateService.ts
- [x] Removed sotuvchi dispatch branch from sendAffiliateOrderByTemplate
- [x] Removed sotuvchi from TemplateType enum — now only "custom" remains
- [x] Removed sotuvchi from TEMPLATE_DEFINITIONS
- [x] 74 tests pass (7 files)

## Phase 49: Color Coding for Target Websites
- [x] Added color property to target_websites table (migration 0010_damp_hammerhead.sql)
- [x] Assigned unique colors to each website: Alijahon (#3b82f6), Mgoods (#8b5cf6), Inbaza (#ec4899), Sotuvchi (#f59e0b), 100k (#10b981)
- [x] Updated TargetWebsites.tsx: cards display with semi-transparent background color (color + 15% opacity)
- [x] New websites default to #6366f1 (indigo) on creation
- [x] 74 tests pass (7 files)

## Phase 50: Accent Bar Color Per Website
- [x] Fixed accent bar in TargetWebsites.tsx to use site.color dynamically (inline style)
- [x] Reverted card background to default (removed bg tint from Phase 49)
- [x] Updated LeadRoutingWizard step 5: icon bg and selected border use site.color
- [x] 74 tests pass (7 files)

## Phase 51: Mobile Responsiveness Improvements
- [ ] Leads page: card layout on mobile (hide table), compact header with icon-only buttons
- [ ] Integrations page: collapsible cards (compact by default, expand on tap)
- [ ] Target Websites page: full name visible (no truncation), compact header
- [ ] All pages: page title + action button on same row
- [ ] All tests pass

## Phase 50: Leads Page SaaS Upgrade
- [ ] Add facebook_forms table to schema (userId, pageId, pageName, formId, formName, platform)
- [ ] Run DB migration
- [ ] Update Facebook connection flow to fetch+save lead forms per page
- [ ] Update leads.list to enrich with pageName+formName from facebook_forms
- [ ] Add page/form/platform filters to leads.list procedure
- [ ] Upgrade Leads page Source column (platform icon + pageName + formName)
- [ ] Add filter dropdowns to Leads page (Page, Form, Platform, Status)
- [ ] Upgrade Lead Detail header (platform badge + page + form + date)
- [ ] Move technical fields to collapsed "Technical Details" section
- [ ] Backfill existing leads pageName/formName from facebook_forms
- [ ] Run all tests and save checkpoint
