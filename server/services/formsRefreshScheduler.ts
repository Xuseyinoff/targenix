/**
 * formsRefreshScheduler.ts
 *
 * Runs every 24 hours to refresh facebook_forms for all users' connected pages.
 * Users create new lead forms regularly — this keeps the DB in sync automatically.
 */

import { refreshAllUsersForms } from "./facebookFormsService";
import { log } from "./appLogger";

let _timer: ReturnType<typeof setTimeout> | null = null;
const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function startFormsRefreshScheduler(): void {
  if (_timer) return; // already running

  const run = async () => {
    await log.info("FACEBOOK", "[FormsRefreshScheduler] Starting 24h forms refresh...");
    try {
      await refreshAllUsersForms();
      await log.info("FACEBOOK", "[FormsRefreshScheduler] Forms refresh complete");
    } catch (err) {
      await log.error("FACEBOOK", "[FormsRefreshScheduler] Error during forms refresh", { error: String(err) });
    }
    // Schedule next run
    _timer = setTimeout(run, INTERVAL_MS);
  };

  // First run after 5 minutes (let server settle), then every 24h
  _timer = setTimeout(run, 5 * 60 * 1000);
  console.log("[FormsRefreshScheduler] Scheduled — first run in 5 minutes, then every 24h");
}

export function stopFormsRefreshScheduler(): void {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
}
