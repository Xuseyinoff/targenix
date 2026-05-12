/**
 * formsRefreshScheduler.ts
 *
 * Runs every 24 hours to refresh facebook_forms for all users' connected pages.
 * Users create new lead forms regularly — this keeps the DB in sync automatically.
 *
 * On failure (e.g. transient Facebook API hiccup at 1am), the scheduler now
 * applies exponential backoff up to a small retry budget BEFORE waiting the
 * full 24h. Without this, a single bad tick = 24h of stale forms = newly
 * created Facebook lead forms invisible to leads coming in during that
 * window.
 */

import { refreshAllUsersForms } from "./facebookFormsService";
import { log } from "./appLogger";

let _timer: ReturnType<typeof setTimeout> | null = null;
let _consecutiveFailures = 0;

const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const INITIAL_DELAY_MS = 5 * 60 * 1000; // 5 min after boot

// Exponential backoff schedule when refreshAllUsersForms throws. Indexed by
// consecutiveFailures-1 (i.e. first retry waits 5 min, then 30 min, then 2h).
// After exhausting the ladder the scheduler falls back to the regular 24h
// cadence so a permanently-broken FB credential doesn't spin the worker.
const RETRY_BACKOFF_MS = [
  5 * 60 * 1000, // 1st retry: 5 min
  30 * 60 * 1000, // 2nd retry: 30 min
  2 * 60 * 60 * 1000, // 3rd retry: 2h
] as const;

export function startFormsRefreshScheduler(): void {
  if (_timer) return; // already running

  const run = async () => {
    await log.info("FACEBOOK", "[FormsRefreshScheduler] Starting 24h forms refresh...");
    let nextDelayMs = INTERVAL_MS;
    try {
      await refreshAllUsersForms();
      await log.info("FACEBOOK", "[FormsRefreshScheduler] Forms refresh complete");
      _consecutiveFailures = 0; // success — reset backoff
    } catch (err) {
      _consecutiveFailures++;
      const backoffIdx = Math.min(_consecutiveFailures - 1, RETRY_BACKOFF_MS.length - 1);
      const backoffWithinBudget = _consecutiveFailures <= RETRY_BACKOFF_MS.length;
      nextDelayMs = backoffWithinBudget ? RETRY_BACKOFF_MS[backoffIdx]! : INTERVAL_MS;

      await log.error(
        "FACEBOOK",
        `[FormsRefreshScheduler] Error during forms refresh (failure #${_consecutiveFailures}, ` +
          `next retry in ${Math.round(nextDelayMs / 60000)}min)`,
        { error: String(err), consecutiveFailures: _consecutiveFailures, nextDelayMs },
      );
    }
    _timer = setTimeout(run, nextDelayMs);
  };

  _timer = setTimeout(run, INITIAL_DELAY_MS);
  console.log(
    "[FormsRefreshScheduler] Scheduled — first run in 5 minutes, then every 24h " +
      "(with 5min/30min/2h backoff on consecutive failures)",
  );
}

export function stopFormsRefreshScheduler(): void {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
  _consecutiveFailures = 0;
}
