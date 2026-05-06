/**
 * crmSyncScheduler.ts
 *
 * Automated CRM order-status sync — runs every 30 minutes in the background.
 * Skips a cycle if a manual sync (triggered via admin UI) is already in progress.
 *
 * Registered in:
 *   server/workers/run.ts          (standalone worker process)
 *   server/_core/index.ts          (embedded worker when START_WORKER=true)
 */

import { performCrmSync, syncState } from "../routers/crmRouter";

const SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const INITIAL_DELAY_MS = 60 * 1000;       // 60 seconds after startup

let schedulerTimer: ReturnType<typeof setTimeout> | null = null;

async function runSync(): Promise<void> {
  if (syncState.running) {
    console.log("[CrmSyncScheduler] Skipping — manual sync already in progress");
    return;
  }

  console.log(`[CrmSyncScheduler] ${new Date().toISOString()} — starting automated CRM status sync`);
  syncState.running = true;
  syncState.aborted = false;
  syncState.progress = null;
  syncState.lastResult = null;

  try {
    // No userId → syncs ALL users' pending orders (scheduler is global)
    const result = await performCrmSync();
    syncState.lastResult = result;
    console.log(
      `[CrmSyncScheduler] Done — synced=${result.synced} errors=${result.errors} total=${result.total}`,
    );
  } catch (err) {
    console.error("[CrmSyncScheduler] Sync failed:", err instanceof Error ? err.message : err);
    syncState.lastResult = {
      synced: 0,
      errors: 1,
      total: 0,
      syncedAt: new Date().toISOString(),
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    syncState.running = false;
    syncState.progress = null;
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

export function startCrmSyncScheduler(): void {
  if (schedulerTimer !== null) return; // idempotent

  console.log(
    `[CrmSyncScheduler] Starting — first sync in ${INITIAL_DELAY_MS / 1000}s, then every ${SYNC_INTERVAL_MS / 60000} min`,
  );

  schedulerTimer = setTimeout(() => {
    void runSync().finally(() => {
      schedulerTimer = null;
      scheduleNext();
    });
  }, INITIAL_DELAY_MS);
}

export function stopCrmSyncScheduler(): void {
  if (schedulerTimer !== null) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
}
