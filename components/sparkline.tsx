"use client";

import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";

export interface SparkPoint {
  ts: string;
  latencyMs: number | null;
}

/** Tiny p95-latency sparkline for a provider card (last 24h of probes). */
export function Sparkline({ data }: { data: SparkPoint[] }) {
  const points = data.filter((d) => d.latencyMs !== null);
  if (points.length < 2) {
    return (
      <div className="h-10 text-xs text-zinc-600 flex items-center">
        collecting data…
      </div>
    );
  }
  return (
    <div className="h-10">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 4, bottom: 4, left: 0, right: 0 }}>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Line
            type="monotone"
            dataKey="latencyMs"
            stroke="#34d399"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
