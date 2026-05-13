/**
 * oauthStateCleanupScheduler.ts
 *
 * Hourly sweep of expired rows from the universal `oauth_states` table.
 *
 * Why a dedicated scheduler instead of relying on the opportunistic call
 * inside `oauthRouter.ts`:
 *   - The router only fires the sweep when SOMEONE starts a new OAuth flow.
 *     If no users initiate OAuth for a while, expired rows accumulate.
 *   - Sprint B (commit fe5ae7f) drops the legacy `facebook_oauth_states`
 *     table and its dedicated hourly cleanup interval. The universal table
 *     now needs the same guarantee.
 *
 * Frequency: once per hour, on the hour. Same cadence used by the other
 * housekeeping schedulers (logRetention, connectionHealth).
 */

import { getDb } from "../db";
import { scheduleCleanupExpiredStates } from "../oauth/stateService";

let cleanupTimer: NodeJS.Timeout | null = null;

function msUntilNextHour(): number {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(now.getUTCHours() + 1, 0, 0, 0);
  return next.getTime() - now.getTime();
}

async function runOnce(): Promise<void> {
  try {
    scheduleCleanupExpiredStates(getDb());
  } catch (err) {
    console.warn("[OAuthStateCleanup] sweep failed:", err instanceof Error ? err.message : String(err));
  }
}

export function startOAuthStateCleanupScheduler(): void {
  if (cleanupTimer !== null) return; // already running

  const scheduleNext = () => {
    const delay = msUntilNextHour();
    const nextRun = new Date(Date.now() + delay);
    console.log(
      `[OAuthStateCleanup] Next sweep at ${nextRun.toISOString()} (in ${Math.round(delay / 60000)} min)`,
    );
    cleanupTimer = setTimeout(async () => {
      await runOnce();
      scheduleNext();
    }, delay);
  };

  // Run immediately on startup to drain anything left over from the previous
  // process, then schedule the recurring on-the-hour cadence.
  void runOnce().then(scheduleNext);
}
