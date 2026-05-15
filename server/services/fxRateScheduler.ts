/**
 * fxRateScheduler.ts
 *
 * Pulls the latest CBU USD rate into `fx_rates` so the rollup worker has
 * fresh exchange data to convert between UZS and USD.
 *
 * Cadence: every 6 hours. CBU publishes rates once a day on weekdays;
 * 6-hour cadence covers the brief window after their morning publish
 * without hammering the API, and the daily UNIQUE on fx_rates.date makes
 * any extra hits idempotent UPSERTs (the same value just gets re-written).
 *
 * Registered in:
 *   server/workers/run.ts          (standalone worker)
 *   server/_core/index.ts          (embedded worker when START_WORKER=true)
 */

import { syncTodayFxRate } from "./fxRateService";

const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const INITIAL_DELAY_MS = 30 * 1000;          // run shortly after boot

let schedulerTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

async function runOnce(): Promise<void> {
  if (running) {
    console.log("[FxRateScheduler] Skip — previous run still in progress");
    return;
  }
  running = true;
  try {
    const result = await syncTodayFxRate();
    if (result) {
      console.log(
        `[FxRateScheduler] CBU rate synced: 1 USD = ${result.uzsPerUsd} UZS (date=${result.date})`,
      );
    } else {
      console.log("[FxRateScheduler] CBU sync produced no row (soft failure)");
    }
  } finally {
    running = false;
  }
}

function scheduleNext(): void {
  schedulerTimer = setTimeout(() => {
    void runOnce().finally(() => {
      schedulerTimer = null;
      scheduleNext();
    });
  }, SYNC_INTERVAL_MS);
}

export function startFxRateScheduler(): void {
  if (schedulerTimer !== null) return;
  console.log(
    `[FxRateScheduler] Armed — first run in ${INITIAL_DELAY_MS / 1000}s, then every ${SYNC_INTERVAL_MS / 60_000}min`,
  );
  schedulerTimer = setTimeout(() => {
    void runOnce().finally(() => {
      schedulerTimer = null;
      scheduleNext();
    });
  }, INITIAL_DELAY_MS);
}

export function stopFxRateScheduler(): void {
  if (schedulerTimer !== null) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
}
