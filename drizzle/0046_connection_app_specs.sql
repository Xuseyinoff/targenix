-- Migration 0046: connection_app_specs + appKey columns + unique connection label.
--
-- Stage 1 — ADMIN TEMPLATE CONTRACT HARDENING.
--
-- Goal: make it IMPOSSIBLE to save or boot a destination template whose
-- `{{SECRET:key}}` tokens are not declared in the app's connection spec.
-- The app spec is the single source of truth for which credentials an
-- affiliate/integration requires, decoupling template authoring from
-- runtime delivery and preventing silent runtime failures.
--
-- This migration is ADDITIVE ONLY — no column is dropped, no data is
-- deleted, no runtime behaviour changes at apply time. The server
-- startup validator (added in the same commit) will fail loudly if the
-- contract is violated AFTER this migration has been applied; rolling
-- back is therefore a code revert + optional schema revert below.
--
-- Changes:
--   1. New table `connection_app_specs` — authoritative list of app
--      credential schemas (api_key / oauth2 / bearer / basic + fields[]).
--   2. `destination_templates.appKey` (nullable) — links a template to
--      its spec. Backfilled for all 4 existing rows via endpointUrl
--      pattern matching. Future rows get appKey enforced at save time.
--   3. `connections.appKey` (nullable) — links a user's connection to
--      its spec. Left nullable to allow gradual adoption by existing
--      rows; new connections set it explicitly.
--   4. `connections.uniq_user_app_label` — prevents the duplicate
--      "Sotuvchi.com (1)", "Sotuvchi.com (2)" naming bug that was
--      observed in production. Scoped to `(userId, appKey, displayName)`
--      so different users can still share the same label.
--   5. Seed rows for the 5 production affiliates: alijahon, mgoods,
--      sotuvchi, inbaza, 100k. Shape MUST match the TypeScript constant
--      in server/integrations/connectionAppSpecs.ts.
--
-- Rollback (reverse migration, one-shot, safe as long as no new code
-- that depends on these columns is live):
--   ALTER TABLE connections DROP INDEX uniq_user_app_label;
--   ALTER TABLE connections DROP COLUMN appKey;
--   ALTER TABLE destination_templates DROP INDEX idx_destination_templates_appKey;
--   ALTER TABLE destination_templates DROP COLUMN appKey;
--   DROP TABLE connection_app_specs;

--> statement-breakpoint
CREATE TABLE `connection_app_specs` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `appKey` VARCHAR(64) NOT NULL,
  `displayName` VARCHAR(128) NOT NULL,
  `authType` ENUM('api_key','oauth2','bearer','basic') NOT NULL,
  `category` VARCHAR(32) NOT NULL DEFAULT 'affiliate',
  `fields` JSON NOT NULL,
  `iconUrl` VARCHAR(512) NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_connection_app_specs_appKey` (`appKey`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
--> statement-breakpoint
ALTER TABLE `destination_templates`
  ADD COLUMN `appKey` VARCHAR(64) NULL,
  ADD INDEX `idx_destination_templates_appKey` (`appKey`);
--> statement-breakpoint
ALTER TABLE `connections`
  ADD COLUMN `appKey` VARCHAR(64) NULL;
--> statement-breakpoint
-- Seed the 5 production affiliates. Each row has exactly one sensitive
-- field keyed `api_key`; this matches every destination_templates row's
-- `{{SECRET:api_key}}` token today and is what boot validation checks.
INSERT INTO `connection_app_specs` (`appKey`, `displayName`, `authType`, `category`, `fields`) VALUES
  ('alijahon',  'Alijahon.uz',  'api_key', 'affiliate',
    JSON_ARRAY(JSON_OBJECT('key','api_key','label','API Key','required',TRUE,'sensitive',TRUE))),
  ('mgoods',    'Mgoods.uz',    'api_key', 'affiliate',
    JSON_ARRAY(JSON_OBJECT('key','api_key','label','API Key','required',TRUE,'sensitive',TRUE))),
  ('sotuvchi',  'Sotuvchi.com', 'api_key', 'affiliate',
    JSON_ARRAY(JSON_OBJECT('key','api_key','label','API Key','required',TRUE,'sensitive',TRUE))),
  ('inbaza',    'Inbaza.uz',    'api_key', 'affiliate',
    JSON_ARRAY(JSON_OBJECT('key','api_key','label','API Key','required',TRUE,'sensitive',TRUE))),
  ('100k',      '100k.uz',      'api_key', 'affiliate',
    JSON_ARRAY(JSON_OBJECT('key','api_key','label','API Key','required',TRUE,'sensitive',TRUE)));
--> statement-breakpoint
-- Backfill appKey on the 4 existing destination_templates rows by
-- matching their endpointUrl against the known affiliate domains.
-- Alijahon has no destination_template row today (it runs as
-- templateType='custom' per-user) — no backfill needed for it.
UPDATE `destination_templates`
   SET `appKey` = CASE
     WHEN `endpointUrl` LIKE '%mgoods.uz%'   THEN 'mgoods'
     WHEN `endpointUrl` LIKE '%100k.uz%'     THEN '100k'
     WHEN `endpointUrl` LIKE '%sotuvchi.com%' THEN 'sotuvchi'
     WHEN `endpointUrl` LIKE '%inbaza.uz%'   THEN 'inbaza'
     WHEN `endpointUrl` LIKE '%alijahon.uz%' THEN 'alijahon'
     ELSE `appKey`
   END
 WHERE `appKey` IS NULL;
--> statement-breakpoint
-- Deliberately NO dedupe pass on `connections` here:
--
--   • Every legacy row has `appKey = NULL`, and MySQL treats NULLs as
--     distinct inside a UNIQUE index, so the constraint below cannot
--     fail on existing data no matter how many duplicate-named rows
--     there are today.
--   • Deleting legacy rows would risk breaking target_websites whose
--     `connectionId` column references them (ON DELETE SET NULL, but
--     still a loss of state the user didn't ask for).
--
-- The practical guarantee is: as soon as any new write sets a non-null
-- `appKey`, subsequent duplicates with the same `(userId, appKey,
-- displayName)` will be rejected. Legacy rows stay untouched.
ALTER TABLE `connections`
  ADD UNIQUE INDEX `uniq_user_app_label` (`userId`, `appKey`, `displayName`);
