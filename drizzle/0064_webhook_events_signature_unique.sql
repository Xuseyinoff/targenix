-- Migration 0064 — Webhook event idempotency by signature
--
-- Sprint 1 / Item 1.1: makes `webhook_events` the durability boundary so
-- a process crash between Facebook's HTTP delivery and our internal
-- processing cannot lose leads. The webhook handler now persists each
-- signed request BEFORE acknowledging Facebook with HTTP 200; on retry
-- (same signature) the INSERT fails with ER_DUP_ENTRY and is treated as
-- "already received".
--
-- MySQL allows multiple rows with NULL in a UNIQUE index, so unsigned
-- test payloads still insert freely (Facebook test pings have no
-- X-Hub-Signature-256 header).
--
-- Safe to apply on a table that already has duplicate signatures (none
-- expected — Facebook never reuses signatures for distinct payloads),
-- but if it does fail with ER_DUP_KEYNAME / 1062 the operator must
-- dedupe webhook_events first.

--> statement-breakpoint
ALTER TABLE `webhook_events`
  ADD UNIQUE INDEX `uniq_webhook_events_signature` (`signature`);
