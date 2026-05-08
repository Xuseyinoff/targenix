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

import { performPaginationSync, performCrmSync, syncState } from "../routers/crmRouter";

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 min between cycles
const INITIAL_DELAY_MS = 60 * 1000;     // 60 seconds after startup
// 100k.uz uses per-order polling — run every 3 min independently of the Sotuvchi pagination cycle.
const HUNDREDK_INTERVAL_MS = 3 * 60 * 1000;
const HUNDREDK_INITIAL_DELAY_MS = 90 * 1000;

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

// ─── 100k.uz independent scheduler ─────────────────────────────────────────

let hundredKTimer: ReturnType<typeof setTimeout> | null = null;

async function run100kSync(): Promise<void> {
  if (syncState.running) {
    console.log("[CrmSyncScheduler/100k] Skipping — global sync already in progress");
    return;
  }
  console.log(`[CrmSyncScheduler/100k] ${new Date().toISOString()} — starting 100k.uz order sync`);
  syncState.running = true;
  syncState.aborted = false;
  syncState.progress = null;
  try {
    const result = await performCrmSync(undefined, "100k");
    syncState.lastResult = result;
    console.log(`[CrmSyncScheduler/100k] Done — synced=${result.synced} errors=${result.errors}`);
  } catch (err) {
    console.error("[CrmSyncScheduler/100k] Sync failed:", err instanceof Error ? err.message : err);
  } finally {
    syncState.running = false;
    syncState.progress = null;
  }
}

function schedule100kNext(): void {
  hundredKTimer = setTimeout(() => {
    void run100kSync().finally(() => {
      hundredKTimer = null;
      schedule100kNext();
    });
  }, HUNDREDK_INTERVAL_MS);
}

export function startCrmSyncScheduler(): void {
  if (schedulerTimer !== null) return; // idempotent

  console.log(
    `[CrmSyncScheduler] Starting — Sotuvchi first in ${INITIAL_DELAY_MS / 1000}s every ${SYNC_INTERVAL_MS / 60000}min; 100k.uz first in ${HUNDREDK_INITIAL_DELAY_MS / 1000}s every ${HUNDREDK_INTERVAL_MS / 60000}min`,
  );

  schedulerTimer = setTimeout(() => {
    void runSync().finally(() => {
      schedulerTimer = null;
      scheduleNext();
    });
  }, INITIAL_DELAY_MS);

  // 100k.uz starts 30 seconds after Sotuvchi to avoid concurrent startup
  hundredKTimer = setTimeout(() => {
    void run100kSync().finally(() => {
      hundredKTimer = null;
      schedule100kNext();
    });
  }, HUNDREDK_INITIAL_DELAY_MS);
}

export function stopCrmSyncScheduler(): void {
  if (schedulerTimer !== null) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
  if (hundredKTimer !== null) {
    clearTimeout(hundredKTimer);
    hundredKTimer = null;
  }
}
