/**
 * fxRateService.ts
 *
 * Thin adapter around the Central Bank of Uzbekistan (CBU) JSON API for
 * daily UZS-per-USD exchange rates. Used by the Insights rollup to express
 * Revenue / Spend in the user's chosen baseCurrency when the underlying
 * transaction is in a different currency.
 *
 * Why CBU specifically:
 *   - Official source — the rate users intuitively expect for their UZS
 *     payouts and ad spend.
 *   - Free, no API key, daily granularity, public stable URLs.
 *   - Has historical endpoint we use for backfill: a request for any past
 *     date returns the rate that was effective on or before that date
 *     (so weekends and holidays Just Work — the API rolls forward to the
 *     prior business day automatically).
 *
 * Response shape (one USD entry):
 *   [{
 *     "Code": "840", "Ccy": "USD", "CcyNm_EN": "US Dollar",
 *     "Nominal": "1", "Rate": "11975.36", "Diff": "-98.06",
 *     "Date": "15.05.2026"
 *   }]
 */
import axios from "axios";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { fxRates } from "../../drizzle/schema";
import { log } from "./appLogger";

const CBU_BASE = "https://cbu.uz/uz/arkhiv-kursov-valyut/json/USD";

interface CbuRow {
  Ccy: string;
  Nominal: string;
  Rate: string;
  Date: string; // DD.MM.YYYY
}

/**
 * Parse CBU's "DD.MM.YYYY" date into "YYYY-MM-DD".
 * Returns null if the input is malformed so the caller can decide what
 * to do with a junk response (today's adapter falls back to "use today").
 */
function parseCbuDate(s: string): string | null {
  const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/**
 * Fetch the USD rate for a given date. Omit `date` to get today's rate.
 *
 * IMPORTANT: CBU returns the rate effective ON OR BEFORE the requested
 * date — never future. The returned `date` field is therefore not always
 * the same as the requested date (weekends/holidays roll backward). We
 * use the API-reported date when persisting so the row reflects ground
 * truth rather than the request that produced it.
 */
export async function fetchCbuUsdRate(date?: string): Promise<{
  date: string;
  uzsPerUsd: string;
} | null> {
  const url = date ? `${CBU_BASE}/${date}/` : `${CBU_BASE}/`;
  const res = await axios.get<CbuRow[]>(url, {
    timeout: 10_000,
    headers: { Accept: "application/json" },
  });
  const row = Array.isArray(res.data) ? res.data.find((r) => r.Ccy === "USD") : null;
  if (!row) return null;

  // Nominal is almost always "1" for USD, but the API technically supports
  // multi-unit quotes (e.g. JPY at Nominal=100). Divide so callers always
  // get the per-1-USD rate.
  const nominal = parseFloat(row.Nominal ?? "1");
  const rateRaw = parseFloat(row.Rate ?? "0");
  if (!Number.isFinite(nominal) || nominal <= 0) return null;
  if (!Number.isFinite(rateRaw) || rateRaw <= 0) return null;

  const uzsPerUsd = (rateRaw / nominal).toFixed(4);
  const isoDate = parseCbuDate(row.Date);
  if (!isoDate) return null;

  return { date: isoDate, uzsPerUsd };
}

/**
 * Upsert a single rate row. Idempotent — repeated calls with the same
 * date+rate are no-ops. Source defaults to 'CBU'; admins can override
 * with 'manual' via direct SQL if a temporary rate adjustment is needed.
 */
export async function upsertFxRate(params: {
  date: string;
  uzsPerUsd: string;
  source?: string;
}): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("DB unavailable");
  const source = params.source ?? "CBU";

  await db
    .insert(fxRates)
    .values({
      date: params.date,
      uzsPerUsd: params.uzsPerUsd,
      source,
    })
    .onDuplicateKeyUpdate({
      set: {
        uzsPerUsd: params.uzsPerUsd,
        source,
      },
    });
}

/**
 * Pull today's CBU rate and persist it. Designed for the daily scheduler;
 * also exported for an admin "Refresh now" button later. Returns the row
 * that was written, or null on a soft failure (logged, not thrown — the
 * scheduler must not crash on a transient CBU outage).
 */
export async function syncTodayFxRate(): Promise<{
  date: string;
  uzsPerUsd: string;
} | null> {
  try {
    const result = await fetchCbuUsdRate();
    if (!result) {
      await log.warn("SYSTEM", "[FxSync] CBU returned no USD row", {});
      return null;
    }
    await upsertFxRate(result);
    return result;
  } catch (err) {
    await log.error("SYSTEM", "[FxSync] CBU fetch failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Look up the rate effective on `date`, falling back to the most recent
 * rate on or before that date. Returns null when no rate at all is on
 * file (first ever sync hasn't run). Callers should treat null the same
 * as "currency mismatch, skip conversion".
 */
export async function getEffectiveRate(date: string): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select({ uzsPerUsd: fxRates.uzsPerUsd })
    .from(fxRates)
    .where(sql`${fxRates.date} <= ${date}`)
    .orderBy(sql`${fxRates.date} DESC`)
    .limit(1);
  return rows[0]?.uzsPerUsd ?? null;
}
