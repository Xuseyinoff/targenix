/**
 * Production-safe batch backfill: set orders.crmStatus from crmRawStatus for final rows
 * using the same mapping as runtime sync (shared/crmStatuses).
 *
 * Env highlights:
 *   CRMS_BACKFILL_UNKNOWN_MAX_COUNT=100       — abort if UNKNOWN rows exceed (0 = off)
 *   CRMS_BACKFILL_UNKNOWN_MAX_RATIO=0.02     — abort if UNKNOWN/scanned exceeds (0 = off)
 *   CRMS_BACKFILL_STRICT_APPKEY=1            — fail on appKey ∉ {sotuvchi,100k,+extras}
 *   CRMS_BACKFILL_EXTRA_APPKEYS=foo,bar       — whitelist more appKeys
 *   CRMS_BACKFILL_MIN_ROW_AGE_HOURS=0        — if >0, only rows older than N hours (by updatedAt)
 *   CRMS_BACKFILL_TX_RETRIES=3                — per-batch transaction retries (deadlock / lock wait only)
 *   CRMS_BACKFILL_ADAPTIVE_SLEEP=1            — tune inter-batch sleep (0 = fixed CRMS_BACKFILL_SLEEP_MS)
 *   CRMS_BACKFILL_SLEEP_MIN_MS / SLEEP_MAX_MS — adaptive clamp (default 40 / 5000)
 *   CRMS_BACKFILL_FINAL_ASSERT=1            — after run, fail if isFinal rows lack terminal crmStatus (off in DRY_RUN)
 *   CRMS_BACKFILL_AUTO_FIX_FINAL=1           — before assert: set isFinal=0 where isFinal but crmStatus not terminal (batched)
 *   CRMS_BACKFILL_AUTO_FIX_BATCH=2000        — rows per auto-fix UPDATE
 *
 * Usage (from repo root):
 *   pnpm exec tsx tooling/mysql/backfill-crm-status-final.ts
 *   DRY_RUN=1 CRMS_BACKFILL_VALIDATE=1 pnpm exec tsx tooling/mysql/backfill-crm-status-final.ts
 *
 * Post-run SQL: tooling/mysql/backfill-crm-status-final.post-check.sql
 */

import "dotenv/config";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import mysql from "mysql2/promise";
import {
  FINAL_STATUSES,
  mapHundredKRawToNormalized,
  mapSotuvchiRawToNormalized,
} from "../../shared/crmStatuses";

const BATCH = Math.max(1, parseInt(process.env.CRMS_BACKFILL_BATCH ?? "500", 10));
const SLEEP_MS = Math.max(0, parseInt(process.env.CRMS_BACKFILL_SLEEP_MS ?? "150", 10));
const ADAPTIVE_SLEEP =
  process.env.CRMS_BACKFILL_ADAPTIVE_SLEEP !== "0" &&
  process.env.CRMS_BACKFILL_ADAPTIVE_SLEEP !== "false";
const SLEEP_MIN_MS = Math.max(0, parseInt(process.env.CRMS_BACKFILL_SLEEP_MIN_MS ?? "40", 10));
const SLEEP_MAX_MS = Math.max(SLEEP_MIN_MS, parseInt(process.env.CRMS_BACKFILL_SLEEP_MAX_MS ?? "5000", 10));
const DRY_RUN =
  process.env.DRY_RUN === "1" ||
  process.env.DRY_RUN === "true" ||
  process.argv.includes("--dry-run");

const VALIDATE_SAMPLE =
  process.env.CRMS_BACKFILL_VALIDATE === "1" ||
  process.env.CRMS_BACKFILL_VALIDATE === "true" ||
  process.argv.includes("--validate-sample");

const UNKNOWN_WARN_LINES = Math.max(0, parseInt(process.env.CRMS_BACKFILL_UNKNOWN_LOG_MAX ?? "40", 10));

/** Abort if cumulative UNKNOWN count exceeds (0 = disabled). */
const UNKNOWN_MAX_COUNT = Math.max(0, parseInt(process.env.CRMS_BACKFILL_UNKNOWN_MAX_COUNT ?? "0", 10));
/** Abort if UNKNOWN/scanned > this (0 = disabled). Example: 0.02 = 2%. */
const UNKNOWN_MAX_RATIO = Math.max(0, parseFloat(process.env.CRMS_BACKFILL_UNKNOWN_MAX_RATIO ?? "0"));

const MIN_ROW_AGE_HOURS = Math.max(0, parseInt(process.env.CRMS_BACKFILL_MIN_ROW_AGE_HOURS ?? "0", 10));

const STRICT_APPKEY =
  process.env.CRMS_BACKFILL_STRICT_APPKEY !== "0" &&
  process.env.CRMS_BACKFILL_STRICT_APPKEY !== "false";

const ALLOWED_APPKEYS = new Set<string>(["sotuvchi", "100k"]);
for (const x of process.env.CRMS_BACKFILL_EXTRA_APPKEYS?.split(",") ?? []) {
  const k = x.trim();
  if (k) ALLOWED_APPKEYS.add(k);
}

const TX_RETRIES = Math.max(1, parseInt(process.env.CRMS_BACKFILL_TX_RETRIES ?? "3", 10));

const FINAL_ASSERT =
  process.env.CRMS_BACKFILL_FINAL_ASSERT !== "0" &&
  process.env.CRMS_BACKFILL_FINAL_ASSERT !== "false";

const AUTO_FIX_FINAL =
  process.env.CRMS_BACKFILL_AUTO_FIX_FINAL === "1" ||
  process.env.CRMS_BACKFILL_AUTO_FIX_FINAL === "true";

const AUTO_FIX_BATCH = Math.max(1, parseInt(process.env.CRMS_BACKFILL_AUTO_FIX_BATCH ?? "2000", 10));

function resolveDatabaseUrl(): string | undefined {
  const candidates = [
    process.env.MYSQL_PUBLIC_URL,
    process.env.MYSQL_URL,
    process.env.DATABASE_URL,
    process.env.SOURCE_MYSQL_URL,
    process.env.TARGET_MYSQL_URL,
  ];
  for (const raw of candidates) {
    const url = raw?.trim().replace(/^=+/, "");
    if (url?.startsWith("mysql://")) return url;
  }
  return undefined;
}

function assertUnknownWithinLimits(scanned: number, unknownRows: number): void {
  if (UNKNOWN_MAX_COUNT > 0 && unknownRows > UNKNOWN_MAX_COUNT) {
    throw new Error(
      `[backfill] ABORT: UNKNOWN count ${unknownRows} > CRMS_BACKFILL_UNKNOWN_MAX_COUNT (${UNKNOWN_MAX_COUNT}) — possible API drift`,
    );
  }
  if (UNKNOWN_MAX_RATIO > 0 && scanned > 0 && unknownRows / scanned > UNKNOWN_MAX_RATIO) {
    throw new Error(
      `[backfill] ABORT: UNKNOWN ratio ${(unknownRows / scanned).toFixed(4)} > CRMS_BACKFILL_UNKNOWN_MAX_RATIO (${UNKNOWN_MAX_RATIO})`,
    );
  }
}

/** Mappers lower-case internally; trim matches SQL TRIM filter. */
function mapRaw(appKey: string | null, raw: string): string {
  const r = raw.trim();
  if (!r) return "new";
  if (appKey === "100k") return mapHundredKRawToNormalized(r);
  return mapSotuvchiRawToNormalized(r);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** MySQL2: prefer `code`; fall back to `errno` (1213 deadlock, 1205 lock wait). */
function isLockRetryableError(e: unknown): boolean {
  const err = e as { code?: string; errno?: number; message?: string };
  if (err.code === "ER_LOCK_DEADLOCK" || err.code === "ER_LOCK_WAIT_TIMEOUT") return true;
  if (err.errno === 1213 || err.errno === 1205) return true;
  return false;
}

function clampSleep(ms: number): number {
  return Math.min(SLEEP_MAX_MS, Math.max(SLEEP_MIN_MS, Math.round(ms)));
}

/** Limit per-batch relative change (clamp ±50% of previous) to avoid throttle overshoot on spikes. */
function nextInterBatchMs(prev: number, batchLockRetries: number): number {
  const prevSafe = Math.max(1, prev);
  const raw = batchLockRetries > 0 ? prevSafe * 1.38 : prevSafe * 0.92;
  const relativeCapped = Math.min(prevSafe * 1.5, Math.max(prevSafe * 0.7, raw));
  return clampSleep(relativeCapped);
}

async function autoFixStaleFinalFlags(pool: mysql.Pool): Promise<number> {
  const terminals = Array.from(FINAL_STATUSES);
  const placeholders = terminals.map(() => "?").join(", ");

  if (DRY_RUN) {
    const [cnt] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM orders
       WHERE isFinal = 1
         AND (crmStatus IS NULL OR crmStatus NOT IN (${placeholders}))`,
      terminals,
    );
    const n = Number(cnt[0]?.n ?? 0);
    console.log(
      `[backfill] AUTO_FIX FINAL (dry-run): would clear isFinal on ~${n.toLocaleString()} row(s) (non-terminal crmStatus vs FINAL_STATUSES)`,
    );
    return 0;
  }

  let total = 0;
  let rounds = 0;
  while (rounds < 50_000) {
    rounds += 1;
    const [res] = await pool.execute<ResultSetHeader>(
      `UPDATE orders SET isFinal = 0
       WHERE id IN (
         SELECT id FROM (
           SELECT id FROM orders
           WHERE isFinal = 1
             AND (crmStatus IS NULL OR crmStatus NOT IN (${placeholders}))
           ORDER BY id ASC
           LIMIT ${AUTO_FIX_BATCH}
         ) AS t
       )`,
      terminals,
    );
    const affected = res.affectedRows ?? 0;
    total += affected;
    if (affected === 0) break;
    console.log(`[backfill] AUTO_FIX FINAL: cleared isFinal on ${affected} row(s) (cumulative=${total})`);
    await sleep(Math.min(500, Math.max(50, SLEEP_MS + 40)));
  }

  console.log(`[backfill] AUTO_FIX FINAL done: total rows updated=${total.toLocaleString()}`);
  return total;
}

function buildBatchUpdate(updates: { id: number; status: string }[]): { sql: string; params: (string | number)[] } {
  const whenParts: string[] = [];
  const params: (string | number)[] = [];
  const ids: number[] = [];
  for (const u of updates) {
    whenParts.push("WHEN ? THEN ?");
    params.push(u.id, u.status);
    ids.push(u.id);
  }
  const placeholders = ids.map(() => "?").join(", ");
  params.push(...ids);
  const sql = `UPDATE orders SET crmStatus = CASE id ${whenParts.join(" ")} END WHERE id IN (${placeholders})`;
  return { sql, params };
}

/**
 * Retries only on ER_LOCK_DEADLOCK / ER_LOCK_WAIT_TIMEOUT; any other error fails immediately.
 * Returns how many lock-related retries were needed (for adaptive throttle).
 */
async function runBatchTransaction(
  pool: mysql.Pool,
  sql: string,
  params: (string | number)[],
): Promise<{ lockRetries: number }> {
  let lockRetries = 0;
  for (let attempt = 1; attempt <= TX_RETRIES; attempt++) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(sql, params);
      await conn.commit();
      return { lockRetries };
    } catch (e) {
      try {
        await conn.rollback();
      } catch {
        /* ignore */
      }

      const code = (e as { code?: string; errno?: number })?.code;
      const errno = (e as { errno?: number })?.errno;

      if (!isLockRetryableError(e)) {
        console.warn(
          `[backfill] batch tx non-retryable error code=${code ?? "?"} errno=${errno ?? "?"} — ${e instanceof Error ? e.message : String(e)}`,
        );
        throw e;
      }

      console.warn(
        `[backfill] lock contention (${code ?? errno}) tx attempt ${attempt}/${TX_RETRIES} — retrying`,
      );

      if (attempt >= TX_RETRIES) throw e;

      lockRetries += 1;
      const backoff = Math.min(1500, 120 * attempt + Math.floor(Math.random() * 80));
      await sleep(backoff);
    } finally {
      conn.release();
    }
  }

  throw new Error("[backfill] runBatchTransaction: exhausted retries unexpectedly");
}

async function assertFinalRowsTerminal(pool: mysql.Pool): Promise<void> {
  const terminals = Array.from(FINAL_STATUSES);
  const placeholders = terminals.map(() => "?").join(", ");
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM orders \nWHERE isFinal = 1 \nAND (crmStatus IS NULL OR crmStatus NOT IN (${placeholders}))`,
    terminals,
  );
  const n = Number(rows[0]?.n ?? 0);
  if (n === 0) {
    console.log("[backfill] Final consistency assert: OK (all isFinal rows use terminal crmStatus per FINAL_STATUSES)");
    return;
  }

  const [sample] = await pool.query<RowDataPacket[]>(
    `SELECT id, crmStatus, crmRawStatus FROM orders \nWHERE isFinal = 1 \nAND (crmStatus IS NULL OR crmStatus NOT IN (${placeholders})) \nLIMIT 8`,
    terminals,
  );
  throw new Error(
    `[backfill] FINAL ASSERT FAILED: ${n} order(s) have isFinal=1 but non-terminal crmStatus (expected one of: ${terminals.join(", ")}). Sample: ${JSON.stringify(sample)}`,
  );
}

/** Optional: skip rows touched very recently (concurrent CRM sync safety). */
function staleRowSqlFragment(): string {
  if (MIN_ROW_AGE_HOURS <= 0) return "";
  return ` AND o.updatedAt <= DATE_SUB(NOW(), INTERVAL ${MIN_ROW_AGE_HOURS} HOUR) `;
}

async function printJoinSample(pool: mysql.Pool): Promise<void> {
  const stale = staleRowSqlFragment();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT o.id, o.crmRawStatus, tw.appKey AS appKey
     FROM orders o
     LEFT JOIN integrations i ON o.integrationId = i.id
     LEFT JOIN target_websites tw ON i.targetWebsiteId = tw.id
     WHERE o.isFinal = 1
       AND o.crmRawStatus IS NOT NULL
       AND TRIM(o.crmRawStatus) <> ''
       ${stale}
     ORDER BY o.id ASC
     LIMIT 50`,
  );
  console.log("[backfill] — validate sample (mapper: appKey=100k → 100k, else Sotuvchi; strict appKey=" + STRICT_APPKEY + ") —");
  for (const r of rows) {
    const ak = r.appKey == null ? "(null→sotuvchi)" : String(r.appKey);
    console.log(`  id=${r.id} appKey=${ak} raw=${JSON.stringify(String(r.crmRawStatus ?? ""))}`);
  }
  console.log("[backfill] — end sample —\n");
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

async function main(): Promise<void> {
  const url = resolveDatabaseUrl();
  if (!url) {
    console.error("[backfill] No mysql:// URL (MYSQL_PUBLIC_URL / MYSQL_URL / DATABASE_URL).");
    process.exit(1);
  }

  const stale = staleRowSqlFragment();
  if (MIN_ROW_AGE_HOURS > 0) {
    console.log(`[backfill] Skipping rows with updatedAt within last ${MIN_ROW_AGE_HOURS}h`);
  }

  const pool = mysql.createPool({ uri: url, charset: "utf8mb4" });
  const started = Date.now();
  try {
    if (VALIDATE_SAMPLE) {
      await printJoinSample(pool);
    }

    const [countRows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM orders o
       WHERE o.isFinal = 1
         AND o.crmRawStatus IS NOT NULL
         AND TRIM(o.crmRawStatus) <> ''
         ${stale}`,
    );
    const totalEligible = Number(countRows[0]?.n ?? 0);
    console.log(
      `[backfill] Eligible rows: ${totalEligible.toLocaleString()} | BATCH=${BATCH} DRY_RUN=${DRY_RUN} ADAPTIVE_SLEEP=${ADAPTIVE_SLEEP} AUTO_FIX_FINAL=${AUTO_FIX_FINAL} FINAL_ASSERT=${FINAL_ASSERT && !DRY_RUN} | UNKNOWN_MAX_COUNT=${UNKNOWN_MAX_COUNT || "off"} UNKNOWN_MAX_RATIO=${UNKNOWN_MAX_RATIO || "off"} STRICT_APPKEY=${STRICT_APPKEY}`,
    );

    let interBatchMs = SLEEP_MS;

    let lastId = 0;
    let scanned = 0;
    let updated = 0;
    let batches = 0;
    let unknownRows = 0;
    let unknownWarnPrinted = 0;
    const unknownByRaw = new Map<string, number>();
    let missingAppKeyRows = 0;
    let missingAppKeyLogged = 0;
    let invalidAppKeyRows = 0;
    let unknownFinalWarned = 0;

    while (true) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT o.id, o.crmStatus, o.crmRawStatus, tw.appKey AS appKey
         FROM orders o
         LEFT JOIN integrations i ON o.integrationId = i.id
         LEFT JOIN target_websites tw ON i.targetWebsiteId = tw.id
         WHERE o.isFinal = 1
           AND o.crmRawStatus IS NOT NULL
           AND TRIM(o.crmRawStatus) <> ''
           AND o.id > ?
           ${stale}
         ORDER BY o.id ASC
         LIMIT ?`,
        [lastId, BATCH],
      );

      if (!rows.length) break;

      lastId = rows[rows.length - 1].id as number;
      scanned += rows.length;

      const changes: { id: number; status: string }[] = [];
      for (const r of rows) {
        const raw = String(r.crmRawStatus ?? "");
        const current = r.crmStatus == null ? null : String(r.crmStatus);
        const rawAppKey = r.appKey == null || r.appKey === "" ? null : String(r.appKey);
        let appKeyForMapper = rawAppKey;

        if (rawAppKey !== null && !ALLOWED_APPKEYS.has(rawAppKey)) {
          invalidAppKeyRows += 1;
          const msg = `[backfill] Invalid appKey ${JSON.stringify(rawAppKey)} orderId=${r.id} — whitelist: sotuvchi,100k + CRMS_BACKFILL_EXTRA_APPKEYS`;
          if (STRICT_APPKEY) throw new Error(msg);
          console.warn(msg + " — using Sotuvchi mapper");
          appKeyForMapper = null;
        }

        if (rawAppKey === null && missingAppKeyLogged < 15) {
          console.warn(
            `[backfill] missing appKey (JOIN) — orderId=${r.id} → Sotuvchi mapper; verify integration/target_website`,
          );
          missingAppKeyLogged += 1;
        }
        if (rawAppKey === null) missingAppKeyRows += 1;

        const next = mapRaw(appKeyForMapper, raw);

        if (next === "unknown") {
          unknownRows += 1;
          const key = raw.trim().toLowerCase() || "(empty)";
          unknownByRaw.set(key, (unknownByRaw.get(key) ?? 0) + 1);
          // WHERE o.isFinal=1: UNKNOWN here => possible API drift / unmapped raw on “final tier” rows.
          if (unknownFinalWarned < 25) {
            console.warn(
              `[backfill] API/MAPPING RISK: UNKNOWN raw on isFinal=1 row — orderId=${r.id} appKey=${rawAppKey ?? "null"} raw=${JSON.stringify(raw)} key=${JSON.stringify(key)}`,
            );
            unknownFinalWarned += 1;
          } else if (unknownWarnPrinted < UNKNOWN_WARN_LINES) {
            console.warn(
              `[backfill] UNKNOWN mapped — orderId=${r.id} appKey=${rawAppKey ?? "null"} raw=${JSON.stringify(raw)} key=${JSON.stringify(key)}`,
            );
            unknownWarnPrinted += 1;
          }
        }

        assertUnknownWithinLimits(scanned, unknownRows);

        if (current !== next) {
          changes.push({ id: r.id as number, status: next });
        }
      }

      let batchLockRetries = 0;
      if (changes.length && !DRY_RUN) {
        const { sql, params } = buildBatchUpdate(changes);
        const tx = await runBatchTransaction(pool, sql, params);
        batchLockRetries = tx.lockRetries;
        updated += changes.length;
      } else if (changes.length && DRY_RUN) {
        updated += changes.length;
        if (batches === 0) {
          console.log("[backfill] DRY_RUN sample:", changes.slice(0, 5));
        }
      }

      batches += 1;

      const elapsedSec = (Date.now() - started) / 1000;
      const rate = elapsedSec > 0 ? scanned / elapsedSec : 0;
      const remaining = Math.max(0, totalEligible - scanned);
      const etaSec = rate > 0 ? remaining / rate : NaN;

      if (batches % 5 === 0 || batches === 1) {
        console.log(
          `[backfill] progress scanned=${scanned.toLocaleString()}/${totalEligible.toLocaleString()} (${((100 * scanned) / Math.max(1, totalEligible)).toFixed(1)}%) ${DRY_RUN ? "would_update=" : "updated="}${updated} unknown=${unknownRows} throttle=${interBatchMs}ms ETA≈${formatEta(etaSec)}`,
        );
      }
      if (batches % 20 === 0) {
        console.log(
          `[backfill] … batches=${batches} rate≈${rate.toFixed(1)} rows/s missing_appKey=${missingAppKeyRows} invalid_appKey=${invalidAppKeyRows}`,
        );
      }

      if (ADAPTIVE_SLEEP) {
        interBatchMs = nextInterBatchMs(interBatchMs, batchLockRetries);
      }
      await sleep(interBatchMs);
    }

    assertUnknownWithinLimits(scanned, unknownRows);

    if (AUTO_FIX_FINAL) {
      await autoFixStaleFinalFlags(pool);
    }

    if (FINAL_ASSERT && !DRY_RUN) {
      await assertFinalRowsTerminal(pool);
    }

    const totalSec = (Date.now() - started) / 1000;
    console.log(
      `[backfill] Done in ${totalSec.toFixed(1)}s. batches=${batches} scanned=${scanned.toLocaleString()} ${DRY_RUN ? "rows_needing_change=" : "rows_updated="}${updated.toLocaleString()}`,
    );
    console.log(
      `[backfill] Telemetry: UNKNOWN=${unknownRows} (isFinal=1 + non-empty raw scan) | missing JOIN appKey=${missingAppKeyRows} | not-whitelisted appKey=${invalidAppKeyRows}`,
    );
    const unknownDetailLines =
      Math.min(unknownRows, 25) + Math.min(Math.max(0, unknownRows - 25), UNKNOWN_WARN_LINES);
    if (unknownRows > unknownDetailLines) {
      console.warn(`[backfill] … +${unknownRows - unknownDetailLines} UNKNOWN log lines suppressed`);
    }
    if (unknownByRaw.size > 0) {
      const sorted = Array.from(unknownByRaw.entries()).sort((a, b) => b[1] - a[1]).slice(0, 30);
      console.log("[backfill] Top UNKNOWN raw keys (lowercase):", Object.fromEntries(sorted));
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("[backfill] Fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
