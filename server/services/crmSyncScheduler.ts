/**
 * crmSyncScheduler.ts
 *
 * Two independent sync loops running in parallel:
 *   Sotuvchi — bulk pagination (200 orders/page). Every 5 min.
 *   100k.uz  — advertiser-orders list pagination (~20/page, 2s between pages). Every 5 min.
 *
 * Each loop owns its own running flag so they never block each other.
 *
 * Registered in:
 *   server/workers/run.ts          (standalone worker process)
 *   server/_core/index.ts          (embedded worker when START_WORKER=true)
 */

import {
  performPaginationSync,
  performPaginationSync100k,
  syncState,
} from "../routers/crmRouter";

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 60 * 1000;
const HUNDREDK_INTERVAL_MS = 5 * 60 * 1000;
const HUNDREDK_INITIAL_DELAY_MS = 90 * 1000;

let schedulerTimer: ReturnType<typeof setTimeout> | null = null;

async function runSync(): Promise<void> {
  if (syncState.running) {
    console.log("[CrmSyncScheduler] Skipping — Sotuvchi sync already in progress");
    return;
  }

  console.log(`[CrmSyncScheduler] ${new Date().toISOString()} — starting Sotuvchi pagination sync`);
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

// ─── 100k.uz independent scheduler ──────────────────────────────────────────
// Uses syncState.running100k — completely separate from Sotuvchi's syncState.running.
// The two loops can now run concurrently without blocking each other.

let hundredKTimer: ReturnType<typeof setTimeout> | null = null;

async function run100kSync(): Promise<void> {
  if (syncState.running100k) {
    console.log("[CrmSyncScheduler/100k] Skipping — 100k sync already in progress");
    return;
  }

  console.log(`[CrmSyncScheduler/100k] ${new Date().toISOString()} — starting 100k.uz order sync`);
  syncState.running100k = true;
  syncState.aborted = false;
  try {
    const result = await performPaginationSync100k();
    syncState.lastResult = result;
    console.log(
      `[CrmSyncScheduler/100k] Done — synced=${result.synced} errors=${result.errors}` +
        (result.message ? ` — ${result.message}` : "") +
        (result.total ? ` (API~rows ${result.total})` : ""),
    );
  } catch (err) {
    console.error("[CrmSyncScheduler/100k] Sync failed:", err instanceof Error ? err.message : err);
  } finally {
    syncState.running100k = false;
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
    `[CrmSyncScheduler] Starting — Sotuvchi in ${INITIAL_DELAY_MS / 1000}s every ${SYNC_INTERVAL_MS / 60000}min; 100k (pagination) in ${HUNDREDK_INITIAL_DELAY_MS / 1000}s every ${HUNDREDK_INTERVAL_MS / 60000}min`,
  );

  schedulerTimer = setTimeout(() => {
    void runSync().finally(() => {
      schedulerTimer = null;
      scheduleNext();
    });
  }, INITIAL_DELAY_MS);

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
