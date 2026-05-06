/**
 * crmSyncScheduler.ts
 *
 * Automated CRM sync via Sotuvchi pagination API.
 * Fetches 200 orders/page, stops at our oldest non-final order (~3 months back).
 * One full cycle: ~225 pages × 800ms ≈ 3 min. Waits 5 min between cycles.
 *
 * Registered in:
 *   server/workers/run.ts          (standalone worker process)
 *   server/_core/index.ts          (embedded worker when START_WORKER=true)
 */

import { performPaginationSync, syncState } from "../routers/crmRouter";

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 min between cycles
const INITIAL_DELAY_MS = 60 * 1000;     // 60 seconds after startup

let schedulerTimer: ReturnType<typeof setTimeout> | null = null;

async function runSync(): Promise<void> {
  if (syncState.running) {
    console.log("[CrmSyncScheduler] Skipping — sync already in progress");
    return;
  }

  console.log(`[CrmSyncScheduler] ${new Date().toISOString()} — starting pagination sync`);
  syncState.running = true;
  syncState.aborted = false;
  syncState.progress = null;
  syncState.lastResult = null;

  try {
    const result = await performPaginationSync();
    syncState.lastResult = result;
    console.log(
      `[CrmSyncScheduler] Done — ${result.message ?? `synced=${result.synced} errors=${result.errors}`}`,
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
    `[CrmSyncScheduler] Starting — first sync in ${INITIAL_DELAY_MS / 1000}s, then every ${SYNC_INTERVAL_MS / 60000} min after each cycle`,
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
