import Papa from "papaparse";
import ExcelJS from "exceljs";

const MAX_IMPORT_BYTES = 5 * 1024 * 1024; // decompressed xlsx expands far beyond this

/**
 * Parse a GIS export (CSV or .xlsx) into tab-name -> raw grid, matching the
 * shape Google Sheets returns so snapshots and diffs work unchanged.
 * Validates size and magic bytes before handing anything to the parsers.
 */
export async function parseImportFile(
  file: File,
): Promise<{ kind: "csv" | "xlsx"; tables: Record<string, string[][]> }> {
  const name = file.name.toLowerCase();
  const buf = Buffer.from(await file.arrayBuffer());

  if (file.size > MAX_IMPORT_BYTES) {
    throw new Error("File too large — exports are capped at 5 MB.");
  }

  if (name.endsWith(".csv") || file.type === "text/csv") {
    const text = buf.toString("utf8");
    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });
    return { kind: "csv", tables: { csv: parsed.data as string[][] } };
  }

  if (name.endsWith(".xlsx")) {
    // real .xlsx is a zip: verify the magic before parsing (rejects renamed junk,
    // legacy .xls masquerading as .xlsx, and polyglot files)
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
      throw new Error("That doesn't look like a valid .xlsx file.");
    }
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

  throw new Error("Unsupported file type — use .csv or .xlsx (legacy .xls isn't supported).");
}
