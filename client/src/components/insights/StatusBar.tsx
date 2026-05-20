/**
 * Insights breakdown — per-row visual status bar.
 *
 * Renders four colour-coded segments showing the relative share of order
 * outcomes for the row. Segments use `total` as the denominator so a row
 * whose orders sum to less than `total` (e.g. `total = leads` while the
 * counts are CRM-bucketed orders) leaves a transparent remainder at the
 * end — a deliberate visual hint that some of the leads have no CRM signal
 * yet.
 *
 * Colour palette intentionally mirrors the surrounding Insights.tsx tone:
 *   emerald-400  delivered (positive terminal)
 *   amber-400    pipeline   (in-flight, non-final)
 *   red-500      trash      (negative terminal)
 *   slate-500    unsynced   (no CRM signal)
 */
interface StatusBarProps {
  delivered: number;
  pipeline: number;
  trash: number;
  unsynced: number;
  /** Denominator for the segment widths. Typically the row's leads count. */
  total: number;
}

export function StatusBar({ delivered, pipeline, trash, unsynced, total }: StatusBarProps) {
  if (total <= 0) {
    return <div className="h-1.5 w-20 rounded bg-slate-700/30 sm:w-20" />;
  }

  const pct = (n: number) => (n / total) * 100;
  const tooltip = `Delivered: ${delivered} · Pipeline: ${pipeline} · Trash: ${trash} · Unsynced: ${unsynced}`;

  return (
    <div
      className="flex h-1.5 w-16 overflow-hidden rounded bg-slate-700/30 sm:w-20"
      title={tooltip}
      aria-label={tooltip}
    >
      {delivered > 0 && (
        <div className="bg-emerald-400" style={{ width: `${pct(delivered)}%` }} />
      )}
      {pipeline > 0 && (
        <div className="bg-amber-400" style={{ width: `${pct(pipeline)}%` }} />
      )}
      {trash > 0 && (
        <div className="bg-red-500" style={{ width: `${pct(trash)}%` }} />
      )}
      {unsynced > 0 && (
        <div className="bg-slate-500" style={{ width: `${pct(unsynced)}%` }} />
      )}
    </div>
  );
}
