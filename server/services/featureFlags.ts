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

type KnownFlag = typeof FLAG_MULTI_DESTINATIONS;

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
 * Test-only: drops the parsed cache so subsequent reads re-read env vars.
 * Never call from production paths.
 */
export function __resetFeatureFlagsCache(): void {
  cache = null;
}
