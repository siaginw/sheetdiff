"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

/**
 * Weekly placed footage as a bar chart — the trend the office actually
 * reports upward, with the week-over-week delta spoken out loud. Data is
 * computed on the server (the same deduped weeklyProduction numbers the
 * report tables use); this component only draws it.
 */
export function WeeklyChart({ weeks }: { weeks: { label: string; ft: number; stoppages: number }[] }) {
  if (weeks.length === 0) return null;
  const fmt = (n: number) => n.toLocaleString("en-US");
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={weeks} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" className="text-border" />
          <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="currentColor" className="text-muted-foreground" />
          <YAxis
            tick={{ fontSize: 11 }}
            stroke="currentColor"
            className="text-muted-foreground"
            tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))}
            width={36}
          />
          <Tooltip
            formatter={(value) => [`${fmt(Number(value))} ft`, "placed"]}
            labelFormatter={(label) => String(label)}
            contentStyle={{ fontSize: 12, borderRadius: 8 }}
          />
          <Bar dataKey="ft" fill="var(--chart-1)" radius={[3, 3, 0, 0]} maxBarSize={40} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
