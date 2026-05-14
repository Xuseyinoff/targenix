import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

/**
 * VirtualTable — row-virtualized `<table>` wrapper. Roadmap #17.
 *
 * Why the "padding row" strategy (and not absolute-positioned <tr>):
 *   Absolutely positioning each <tr> takes it out of table flow, which
 *   breaks the browser's column auto-sizing — every consumer would then
 *   have to hand-assign column widths and switch to `table-layout: fixed`.
 *   Instead we keep every VISIBLE row in normal document flow and bracket
 *   them with two spacer <tr>s whose heights sum to the off-screen rows.
 *   Column auto-sizing keeps working untouched; the only constraint is
 *   that rows are roughly uniform height (the virtualizer still measures
 *   real heights via measureElement, so minor variance is fine).
 *
 * Threshold gating:
 *   Below `virtualizeThreshold` rows we render everything plainly — no
 *   virtualizer, no spacer rows. The default 50-row page is therefore
 *   byte-for-byte identical to the pre-virtualization render. The cost
 *   (scroll listener, range math, measureElement refs) is only paid when
 *   a page actually gets large enough to matter.
 *
 * The component owns the scroll viewport (max-height + overflow:auto) so
 * a big table scrolls *inside itself* instead of growing the page — the
 * filter controls above it stay pinned in view.
 */

export interface VirtualTableProps<T> {
  rows: T[];
  /** Stable React key per row. */
  rowKey: (row: T) => string | number;
  /** Renders the `<th>` cells. Wrapped in a `<tr>` by this component. */
  renderHeader: () => React.ReactNode;
  /** Renders the `<td>` cells for one row. Wrapped in a `<tr>` by this
   *  component (so the consumer never spreads its own `<tr>`). */
  renderRow: (row: T) => React.ReactNode;
  /** Optional className applied to every data `<tr>` — static string or a
   *  per-row function. Use this for hover styles, status tints, etc. that
   *  would otherwise live on the consumer's own `<tr>`. */
  rowClassName?: string | ((row: T) => string);
  /** Column count — used for the spacer rows' colSpan. */
  columnCount: number;
  /** Estimated row height in px. The virtualizer corrects this per-row
   *  via measureElement; a rough estimate is fine. */
  estimateRowHeight: number;
  /** Rows above which virtualization engages. Default 60 — just above the
   *  common 50-per-page default so the normal case is never virtualized. */
  virtualizeThreshold?: number;
  /** Extra rows rendered beyond the viewport on each side. Default 8. */
  overscan?: number;
  /** Scroll viewport max-height. Default "calc(100vh - 320px)". */
  maxHeight?: string;
  /** Optional className on the `<table>`. */
  tableClassName?: string;
  /** Optional className on the `<thead>`. */
  theadClassName?: string;
  /** Optional className on the `<tbody>`. */
  tbodyClassName?: string;
}

export function VirtualTable<T>({
  rows,
  rowKey,
  renderHeader,
  renderRow,
  rowClassName,
  columnCount,
  estimateRowHeight,
  virtualizeThreshold = 60,
  overscan = 8,
  maxHeight = "calc(100vh - 320px)",
  tableClassName,
  theadClassName,
  tbodyClassName,
}: VirtualTableProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldVirtualize = rows.length >= virtualizeThreshold;

  const resolveRowClass = (row: T): string | undefined =>
    typeof rowClassName === "function" ? rowClassName(row) : rowClassName;

  // The hook must be called unconditionally (rules of hooks). When we're
  // below the threshold we simply ignore its output and render all rows.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimateRowHeight,
    overscan,
  });

  const virtualItems = shouldVirtualize ? virtualizer.getVirtualItems() : [];
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const paddingBottom =
    virtualItems.length > 0
      ? totalSize - virtualItems[virtualItems.length - 1].end
      : 0;

  return (
    <div
      ref={scrollRef}
      className="overflow-auto"
      style={{ maxHeight }}
    >
      <table className={tableClassName}>
        <thead className={theadClassName}>{renderHeader()}</thead>
        <tbody className={tbodyClassName}>
          {shouldVirtualize ? (
            <>
              {paddingTop > 0 && (
                <tr aria-hidden="true">
                  <td colSpan={columnCount} style={{ height: paddingTop, padding: 0, border: 0 }} />
                </tr>
              )}
              {virtualItems.map((vi) => {
                const row = rows[vi.index];
                return (
                  <tr
                    key={rowKey(row)}
                    data-index={vi.index}
                    ref={virtualizer.measureElement}
                    className={resolveRowClass(row)}
                  >
                    {renderRow(row)}
                  </tr>
                );
              })}
              {paddingBottom > 0 && (
                <tr aria-hidden="true">
                  <td colSpan={columnCount} style={{ height: paddingBottom, padding: 0, border: 0 }} />
                </tr>
              )}
            </>
          ) : (
            rows.map((row) => (
              <tr key={rowKey(row)} className={resolveRowClass(row)}>
                {renderRow(row)}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
