/**
 * Lightweight feature-flag primitives for Phase 4 / Commit 5 rollout.
 *
 * Why env-driven for now: we want admins to opt selected users into the
 * new multi-destination code paths without a DB migration, and without
 * any UI ceremony. One env var lists the allow-listed user IDs, and a
 * second env var flips a global override on for everyone (emergency
 * rollout or local dev).
 *
 *   MULTI_DEST_USER_IDS=1,42,100   // comma-separated, trimmed
 *   MULTI_DEST_ALL=true            // optional global override
 *
 * The list is parsed lazily on the first access and cached. Tests can
 * force a re-parse by calling `__resetFeatureFlagsCache()`.
 *
 * If/when we need per-user toggles at scale (e.g. admin UI), this module
 * becomes the single choke-point to swap in — callers consume
 * isMultiDestinationsEnabled(userId) and don't care where the decision
 * came from.
 */

// ─── Known flags ───────────────────────────────────────────────────────────

/**
 * Compile-time default for the Stage 3 "connection-only secrets" model.
 * Runtime behaviour is still driven by env vars — this constant exists so
 * call sites and documentation can refer to a single name. Unset/empty
 * env means the same as `false` (legacy `templateConfig.secrets` fallback
 * still permitted). Phase 4 flips the envs to `true` per rollout plan.
 */
export const USE_CONNECTION_SECRETS_ONLY_DEFAULT = false as const;

/**
 * Routes integration dispatch through the new `integration_destinations`
 * table instead of the legacy `integrations.targetWebsiteId` column. Also
 * gates the new Make.com-style `/integrations/new-v2` wizard on the client.
 *
 * Rollout checklist (do these before setting MULTI_DEST_ALL=true):
 *   - [5a] dual-read resolver lands in leadService.ts             — done
 *   - [5b] v2 wizard routes available                             — done
 *   - [5c.1] targetWebsites.create returns {id, name, templateType} — done
 *   - [5c.2] DestinationCreatorDrawer renders manifest-driven forms — done
 *   - [5c.3] Google OAuth popup auto-selects the new connection    — done
 *   - [5d]   Telegram inline add-bot dialog auto-selects           — done
 *   - [6]    Multi-destination fan-out in leadService (out of scope here)
 *
 * Until [6] ships the resolver returns at most one destination even under
 * the new code path, so enabling this flag is safe in production — it just
 * surfaces the new UI. Enable in three steps:
 *   1. MULTI_DEST_USER_IDS=1          → founders / owners only.
 *   2. MULTI_DEST_USER_IDS=1,42,…     → internal beta cohort.
 *   3. MULTI_DEST_ALL=true            → global; revisit only after [6].
 */
export const FLAG_MULTI_DESTINATIONS = "multi_destinations" as const;

/**
 * Stage 3 — CONNECTION-ONLY SECRET MODEL.
 *
 * When ON, `resolveSecretsForDelivery` refuses to fall back to the legacy
 * `target_websites.templateConfig.secrets` store when no active
 * connection exists. The delivery short-circuits with a loud
 * `ConnectionRequiredError` instead of silently emitting an empty
 * credential — the same fail-loud shape as
 * `ConnectionSecretMissingError`, differentiated by code so the UI can
 * point the operator at "create a connection" instead of "re-enter
 * credentials in the existing connection".
 *
 * OFF by default. Rollout:
 *   1. Deploy Phase 1 (this file + resolver change) with flag OFF —
 *      behaviour stays byte-for-byte identical, we only gain the new
 *      error type in the library.
 *   2. Ship Phase 2 (createFromConnection stops copying secrets) so
 *      new destinations are connection-only from day one.
 *   3. Run Phase 3 migration script to backfill `connectionId` on old
 *      destinations whose template matches an existing connection.
 *   4. Flip to USE_CONNECTION_SECRETS_ONLY=true. From this moment
 *      every delivery without a connection fails loudly.
 *
 * ROLLBACK is always safe: set back to false, deliveries resume reading
 * `templateConfig.secrets`. No data is ever deleted along this path.
 *
 * Envs (per-user allowlist first, then global kill-switch):
 *   USE_CONNECTION_SECRETS_ONLY_USER_IDS=1,42   // comma-separated
 *   USE_CONNECTION_SECRETS_ONLY_ALL=true        // global override
 *
 * We also honour a bare USE_CONNECTION_SECRETS_ONLY env (no suffix) as
 * an alias for the _ALL variant so the variable name from the Stage 3
 * spec stays recognisable in Railway's UI.
 */
export const FLAG_CONNECTION_SECRETS_ONLY = "connection_secrets_only" as const;

type KnownFlag =
  | typeof FLAG_MULTI_DESTINATIONS
  | typeof FLAG_CONNECTION_SECRETS_ONLY;

// ─── Internal cache ────────────────────────────────────────────────────────

interface FlagConfig {
  globalOn: boolean;
  allowedUserIds: Set<number>;
}

let cache: Record<KnownFlag, FlagConfig> | null = null;

function parseUserIds(raw: string | undefined): Set<number> {
  if (!raw) return new Set();
  const out = new Set<number>();
  for (const chunk of raw.split(",")) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const n = Number(trimmed);
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) {
      out.add(n);
    } else {
      // A malformed entry shouldn't silently enable everyone — warn loudly.
      console.warn(
        `[featureFlags] Ignoring non-numeric user id "${trimmed}" in allowlist env var`,
      );
    }
  }
  return out;
}

function parseBool(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function buildCache(): Record<KnownFlag, FlagConfig> {
  return {
    [FLAG_MULTI_DESTINATIONS]: {
      globalOn: parseBool(process.env.MULTI_DEST_ALL),
      allowedUserIds: parseUserIds(process.env.MULTI_DEST_USER_IDS),
    },
    [FLAG_CONNECTION_SECRETS_ONLY]: {
      // Either the dedicated _ALL variant or the bare
      // USE_CONNECTION_SECRETS_ONLY env flips the global kill-switch.
      globalOn:
        parseBool(process.env.USE_CONNECTION_SECRETS_ONLY_ALL) ||
        parseBool(process.env.USE_CONNECTION_SECRETS_ONLY),
      allowedUserIds: parseUserIds(process.env.USE_CONNECTION_SECRETS_ONLY_USER_IDS),
    },
  };
}

function getConfig(flag: KnownFlag): FlagConfig {
  if (!cache) cache = buildCache();
  return cache[flag];
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Returns true when the caller user should take the new multi-destination
 * code path. Safe to call from hot paths: cached after the first access.
 *
 * Decision precedence:
 *   1. Global override (MULTI_DEST_ALL=true) — wins always.
 *   2. Per-user allowlist (MULTI_DEST_USER_IDS).
 *   3. Otherwise off.
 */
export function isMultiDestinationsEnabled(userId: number | null | undefined): boolean {
  if (userId == null || !Number.isFinite(userId) || userId <= 0) return false;
  const cfg = getConfig(FLAG_MULTI_DESTINATIONS);
  if (cfg.globalOn) return true;
  return cfg.allowedUserIds.has(userId);
}

/**
 * Tiny diagnostic helper — useful from admin pages / CLI to quickly
 * confirm which users are opted in without leaking the full env var
 * elsewhere.
 */
export function describeMultiDestinationFlag(): {
  globalOn: boolean;
  allowedUserIds: number[];
} {
  const cfg = getConfig(FLAG_MULTI_DESTINATIONS);
  return {
    globalOn: cfg.globalOn,
    allowedUserIds: Array.from(cfg.allowedUserIds).sort((a, b) => a - b),
  };
}

/**
 * Stage 3 — runtime predicate consumed by `resolveSecretsForDelivery`.
 *
 * Returns true when the given tenant should be denied the legacy
 * `templateConfig.secrets` fallback (i.e. connections are the ONLY
 * source of truth for secrets). See FLAG_CONNECTION_SECRETS_ONLY
 * for the rollout contract.
 *
 * Decision precedence mirrors `isMultiDestinationsEnabled`:
 *   1. Global override (USE_CONNECTION_SECRETS_ONLY_ALL or
 *      USE_CONNECTION_SECRETS_ONLY) — wins always.
 *   2. Per-user allowlist (USE_CONNECTION_SECRETS_ONLY_USER_IDS).
 *   3. Otherwise off (legacy fallback still permitted).
 *
 * Conservative default: callers that cannot supply a valid userId
 * (`null`, `undefined`, NaN, ≤0) see `false`. Refusing to emit empty
 * credentials from an unknown caller is the job of the upstream
 * validation layer — the resolver must never harden delivery for a
 * tenant it cannot identify, or a bug elsewhere in the pipeline could
 * mass-break production once the global kill-switch flips.
 */
export function isConnectionSecretsOnlyEnabled(
  userId: number | null | undefined,
): boolean {
  if (userId == null || !Number.isFinite(userId) || userId <= 0) return false;
  const cfg = getConfig(FLAG_CONNECTION_SECRETS_ONLY);
  if (cfg.globalOn) return true;
  return cfg.allowedUserIds.has(userId);
}

/**
 * Diagnostic sibling to `describeMultiDestinationFlag`. Intentionally
 * symmetric: the admin "feature flags" UI should be able to render
 * both with the same React component.
 */
export function describeConnectionSecretsOnlyFlag(): {
  globalOn: boolean;
  allowedUserIds: number[];
} {
  const cfg = getConfig(FLAG_CONNECTION_SECRETS_ONLY);
  return {
    globalOn: cfg.globalOn,
    allowedUserIds: Array.from(cfg.allowedUserIds).sort((a, b) => a - b),
  };
}

/**
 * Test-only: drops the parsed cache so subsequent reads re-read env vars.
 * Never call from production paths.
 */
export function __resetFeatureFlagsCache(): void {
  cache = null;
}
