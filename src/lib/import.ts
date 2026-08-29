import Papa from "papaparse";
import ExcelJS from "exceljs";

/**
 * Parse a GIS export (CSV or .xlsx) into tab-name -> raw grid, matching the
 * shape Google Sheets returns so snapshots and diffs work unchanged.
 */
export async function parseImportFile(
  file: File,
): Promise<{ kind: "csv" | "xlsx"; tables: Record<string, string[][]> }> {
  const name = file.name.toLowerCase();
  const buf = Buffer.from(await file.arrayBuffer());

  if (name.endsWith(".csv") || file.type === "text/csv") {
    const text = buf.toString("utf8");
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });
    return { kind: "csv", tables: { csv: parsed.data as string[][] } };
  }

  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const wb = new ExcelJS.Workbook();
    // exceljs's bundled Buffer type is stale; runtime accepts any Buffer view
    await wb.xlsx.load(buf as unknown as never);
    const tables: Record<string, string[][]> = {};
    wb.eachSheet((ws) => {
      const grid: string[][] = [];
      ws.eachRow((row) => {
        const vals: string[] = [];
        const r = row as unknown as { values: Record<number, unknown> };
        const max = Math.max(1, ...Object.keys(r.values ?? {}).map(Number).filter((n) => !isNaN(n)));
        for (let c = 1; c <= max; c++) {
          const v = r.values?.[c];
          vals.push(
            v instanceof Date
              ? v.toISOString().slice(0, 10)
              : v == null
                ? ""
                : String(v),
          );
        }
        grid.push(vals);
      });
      tables[ws.name] = grid;
    });
    return { kind: "xlsx", tables };
  }

  throw new Error("Unsupported file type — use .csv or .xlsx");
}
