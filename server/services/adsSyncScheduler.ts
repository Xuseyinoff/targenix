/**
 * adsSyncScheduler.ts
 *
 * Background scheduler that syncs Facebook Ads data every 10 minutes.
 * Runs in the worker process (server/workers/run.ts), NOT in the web server.
 *
 * Strategy:
 *  - First run: delayed 30 seconds after startup (let server settle)
 *  - Subsequent runs: every 10 minutes
 *  - Errors in one account do NOT stop the rest
 */

import { syncAllUsersAdsData } from "./adsSyncService";

const SYNC_INTERVAL_MS = 60 * 60 * 1000; // 60 minutes
const INITIAL_DELAY_MS = 30 * 1000;       // 30 seconds after startup

let schedulerTimer: ReturnType<typeof setTimeout> | null = null;

async function runSync(): Promise<void> {
  console.log(`[AdsSyncScheduler] ${new Date().toISOString()} — starting ads data sync`);
  try {
    await syncAllUsersAdsData();
  } catch (err) {
    console.error("[AdsSyncScheduler] Sync failed:", err instanceof Error ? err.message : err);
  }
}

function scheduleNext(): void {
  schedulerTimer = setTimeout(() => {
    void runSync().finally(() => {
      schedulerTimer = null;
      scheduleNext();
    });
  }, SYNC_INTERVAL_MS);
}

export function startAdsSyncScheduler(): void {
  if (schedulerTimer !== null) return; // already running

  console.log(`[AdsSyncScheduler] Starting — first sync in ${INITIAL_DELAY_MS / 1000}s, then every ${SYNC_INTERVAL_MS / 60000} min`);

  // Delay initial sync to avoid hammering FB API at server startup
  schedulerTimer = setTimeout(() => {
    void runSync().finally(() => {
      schedulerTimer = null;
      scheduleNext();
    });
  }, INITIAL_DELAY_MS);
}

export function stopAdsSyncScheduler(): void {
  if (schedulerTimer !== null) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
}
