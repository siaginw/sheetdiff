import { oldRowValues, type DiffResult, type DiffRow } from "./engine";

/**
 * Per-column widths (in ch) so mono cells align across all diff lines.
 * Pure layout math, extracted from the client component so it is testable:
 * headers set the minimum, visible cells grow it (capped), and removed /
 * changed rows are measured by their OLD values so the "−" lines fit too.
 */
export function columnWidths(
  result: Pick<DiffResult, "columns">,
  rows: DiffRow[],
): number[] {
  const widths = result.columns.map((c) => Math.max(3, c.header.length));
  for (const row of rows) {
    const vals = row.status === "removed" || row.status === "changed" ? oldRowValues(row) : row.values;
    for (let i = 0; i < vals.length; i++) {
      widths[i] = Math.max(widths[i], Math.min(vals[i].length, 22));
    }
  }
  return widths.map((w) => Math.min(w, 22));
}
