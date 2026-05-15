/**
 * One-off: backfill the last N days of USD/UZS rates from CBU.
 *
 * The rollup worker joins fx_rates by the LEAD'S date, then falls back to
 * the most recent earlier date if that exact day is missing. Backfilling
 * the trailing window once on first deploy means the very first rollup
 * pass has accurate FX conversion for every existing day in scope.
 *
 * Usage:
 *   railway run pnpm exec tsx tooling/backfill-fx-rates.ts [--days N] [--pace MS]
 *
 * Defaults: 90 days, 200 ms between calls.
 */
import "dotenv/config";
import { fetchCbuUsdRate, upsertFxRate } from "../server/services/fxRateService";

const argMap = Object.fromEntries(
  process.argv.slice(2).flatMap((a) => {
    const m = a.match(/^--([\w-]+)=?(.*)$/);
    return m ? [[m[1], m[2] || "true"]] : [];
  }),
);
const DAYS = Number(argMap.days ?? "90") || 90;
const PACE_MS = Number(argMap.pace ?? "200") || 200;

console.log(`[fx-backfill] window=${DAYS}d pace=${PACE_MS}ms/call`);

const today = new Date();
const dates: string[] = [];
for (let i = 0; i < DAYS; i++) {
  const d = new Date(today);
  d.setUTCDate(d.getUTCDate() - i);
  dates.push(d.toISOString().slice(0, 10));
}

let upserted = 0;
let failed = 0;
const writtenDates = new Set<string>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

for (let i = 0; i < dates.length; i++) {
  const d = dates[i];
  try {
    const result = await fetchCbuUsdRate(d);
    if (result) {
      // CBU rolls back to the previous business day for weekends/holidays.
      // De-dupe by the API-reported date so we don't re-write the same row
      // 3 times for a Sat/Sun/Mon trio that all share a Friday rate.
      if (!writtenDates.has(result.date)) {
        await upsertFxRate(result);
        writtenDates.add(result.date);
        upserted++;
      }
    } else {
      failed++;
    }
  } catch (err) {
    failed++;
    if (failed <= 3) {
      console.warn(`[fx-backfill] ${d} err:`, err instanceof Error ? err.message : String(err));
    }
  }

  if ((i + 1) % 20 === 0) {
    console.log(`[fx-backfill] ${i + 1}/${dates.length} — upserted=${upserted} failed=${failed}`);
  }
  if (i < dates.length - 1) await sleep(PACE_MS);
}

console.log(`\n[fx-backfill] done — upserted=${upserted} (distinct rate dates) failed=${failed}`);
process.exit(0);
