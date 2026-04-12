/** Dashboard “today” / calendar-day boundaries for analytics. */
export const DASHBOARD_IANA_TZ = "Asia/Tashkent";

/**
 * UTC instants [start, end) for the calendar day of `anchor` in {@link DASHBOARD_IANA_TZ}.
 * Uzbekistan uses year-round UTC+5 (no DST), so a fixed offset is correct for local midnight math.
 */
export function getDashboardDayUtcBounds(anchor: Date = new Date()): { start: Date; end: Date } {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: DASHBOARD_IANA_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(anchor);
  const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
  const offsetMs = 5 * 60 * 60 * 1000;
  const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - offsetMs);
  const end = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0, 0) - offsetMs);
  return { start, end };
}
