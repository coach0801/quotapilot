export interface UptimeCell {
  day: string;
  /** up/total ratio for that day, or null when no probes ran. */
  ratio: number | null;
}

function cellColor(ratio: number | null): string {
  if (ratio === null) return "bg-zinc-800";
  if (ratio >= 0.99) return "bg-emerald-500";
  if (ratio >= 0.9) return "bg-amber-400";
  return "bg-red-500";
}

/** 30-day uptime bar (one cell per UTC day, oldest → newest). */
export function UptimeBar({ cells }: { cells: UptimeCell[] }) {
  return (
    <div className="flex gap-[2px]" title="30-day uptime (per UTC day)">
      {cells.map((c) => (
        <div
          key={c.day}
          className={`h-6 flex-1 rounded-[2px] ${cellColor(c.ratio)}`}
          title={
            c.ratio === null
              ? `${c.day}: no data`
              : `${c.day}: ${(c.ratio * 100).toFixed(1)}% up`
          }
        />
      ))}
    </div>
  );
}
