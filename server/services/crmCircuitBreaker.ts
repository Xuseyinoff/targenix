/**
 * Lightweight per-account circuit breaker for CRM sync (sotuvchi / 100k).
 *
 * Why it exists (audit P0):
 * The crmSyncScheduler runs every 5 minutes and walks paginated lists from
 * external CRMs. If a CRM is down (5xx, network timeout) or our credentials
 * are persistently bad (auth loop), the scheduler kept hammering the
 * endpoint every cycle — wasting outbound budget, filling logs with the
 * same error, and exacerbating the upstream issue.
 *
 * This module is intentionally simpler than the destinations-side
 * `circuitBreaker.ts`:
 *   • Per-account (crm_connections.id), not per-delivery.
 *   • In-memory only — Map<accountId, AccountState>. Restart resets state;
 *     fine because the next sync cycle re-discovers any persistent failure.
 *   • Multi-replica: each replica has its own Map, so the worst-case is
 *     (replica count) sync attempts per cooldown window. Still 5-20x better
 *     than per-cycle.
 *
 * Policy:
 *   3 consecutive failures  → 5 min cooldown
 *   4 consecutive failures  → 15 min cooldown
 *   5+ consecutive failures → 1 hour cooldown
 * One success wipes the streak.
 */

interface AccountState {
  consecutiveFailures: number;
  cooldownUntilMs: number; // 0 = no active cooldown
}

const state = new Map<number, AccountState>();

const FAILURE_THRESHOLD = 3;
const COOLDOWN_LADDER_MS: ReadonlyArray<number> = [
  5 * 60 * 1000,
  15 * 60 * 1000,
  60 * 60 * 1000,
];

export interface SkipDecision {
  skip: boolean;
  /** Human-readable reason when skip=true. */
  reason?: string;
  /** Cooldown expiry epoch ms when skip=true. */
  cooldownUntilMs?: number;
}

export function shouldSkipCrmAccount(
  accountId: number,
  now: number = Date.now(),
): SkipDecision {
  const s = state.get(accountId);
  if (!s) return { skip: false };
  if (s.cooldownUntilMs > now) {
    const secondsLeft = Math.ceil((s.cooldownUntilMs - now) / 1000);
    return {
      skip: true,
      reason: `cooldown active for ${secondsLeft}s after ${s.consecutiveFailures} consecutive failures`,
      cooldownUntilMs: s.cooldownUntilMs,
    };
  }
  return { skip: false };
}

export function recordCrmFailure(accountId: number, now: number = Date.now()): void {
  const prev = state.get(accountId) ?? { consecutiveFailures: 0, cooldownUntilMs: 0 };
  const consecutiveFailures = prev.consecutiveFailures + 1;
  let cooldownUntilMs = prev.cooldownUntilMs;
  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    const ladderIdx = Math.min(
      consecutiveFailures - FAILURE_THRESHOLD,
      COOLDOWN_LADDER_MS.length - 1,
    );
    cooldownUntilMs = now + COOLDOWN_LADDER_MS[ladderIdx];
  }
  state.set(accountId, { consecutiveFailures, cooldownUntilMs });
}

export function recordCrmSuccess(accountId: number): void {
  // Drop the entry entirely on success — keeps the Map bounded by active
  // failing accounts only.
  state.delete(accountId);
}

/** Test/debug helper — exposes the internal state. NOT for production use. */
export function _getCrmCircuitBreakerState(): ReadonlyMap<number, Readonly<AccountState>> {
  return state;
}

/** Test helper — wipe state between tests. */
export function _resetCrmCircuitBreaker(): void {
  state.clear();
}
