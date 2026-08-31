import Papa from "papaparse";
import zlib from "node:zlib";
import ExcelJS from "exceljs";

const MAX_IMPORT_BYTES = 5 * 1024 * 1024; // compressed cap
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024; // decompression-bomb guard

/**
 * Sum the declared uncompressed sizes from a zip's central directory WITHOUT
 * decompressing anything — a crafted 5 MB xlsx can declare gigabytes, and
 * exceljs would happily materialize them into heap.
 */
function zipUncompressedSize(buf: Buffer): number | null {
  // find End Of Central Directory (scan back over the 22-byte record + comment)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_536); i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (ptr + 46 > buf.length) return null;
    if (buf.readUInt32LE(ptr) !== 0x02014b50) return null; // central dir signature
    total += buf.readUInt32LE(ptr + 24); // uncompressed size
    ptr += 46 + buf.readUInt16LE(ptr + 28) + buf.readUInt16LE(ptr + 30) + buf.readUInt16LE(ptr + 32);
  }
  return total;
}

/**
 * ExcelJS cell values come in many shapes; production trackers are full of
 * formulas ({formula, result}), rich text ({richText}), hyperlinks, and Dates.
 * Always resolve to the DISPLAYED text — the computed result for formulas.
 */
/** Trial-inflate every DEFLATE entry with a hard cap — the only guard that
 *  can't be bypassed by lying in the central directory.
 *
 *  Walks the CENTRAL DIRECTORY, not the local headers: streamed entries (flag
 *  bit 3, all of Google's exports) carry 0-size placeholders in their local
 *  headers, and skipping them (the old behavior) left descriptor-flagged
 *  bombs un-inflated — a 522 KB file was observed materializing 512 MB in
 *  heap after both guards passed. The central directory carries the true
 *  compressed sizes even for descriptor entries, and its offsets let each
 *  entry's data be located and trial-inflated against a SHARED budget. */
function verifyActualZipSize(buf: Buffer, limit: number): void {
  // locate End Of Central Directory (scan back over the record + comment)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("[zip] no end-of-central-directory");
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  let budget = limit;
  for (let n = 0; n < count; n++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error("[zip] unreadable central directory");
    }
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    ptr += 46 + nameLen + extraLen + commentLen;
    if (localOffset + 30 > buf.length) throw new Error("[zip] entry offset out of range");
    // the local header's own name/extra lengths locate the data (they can
    // legitimately differ from the central directory's)
    const dataStart =
      localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (compSize === 0) continue; // directories / truly empty entries
    if (dataStart + compSize > buf.length) throw new Error("[zip] entry data out of range");
    if (method === 8) {
      const out = zlib.inflateRawSync(buf.subarray(dataStart, dataStart + compSize), {
        maxOutputLength: budget,
      });
      budget -= out.length;
    } else {
      budget -= compSize; // stored (uncompressed) entry
    }
    if (budget <= 0) throw new Error("[zip] expands over the limit");
  }
}

function cellText(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("result" in o) return cellText(o.result); // formula cell → computed value
    if ("text" in o && typeof o.text === "string") return o.text; // hyperlink
    if (Array.isArray(o.richText)) {
      return o.richText.map((t) => cellText((t as { text?: unknown }).text)).join("");
    }
    return "";
  }
  return String(v);
}

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
    const declared = zipUncompressedSize(buf);
    if (declared !== null && declared > MAX_UNCOMPRESSED_BYTES) {
      throw new Error(`That workbook declares ${Math.round(declared / 1_048_576)} MB uncompressed — over the 64 MB limit.`);
    }
    // declared sizes are attacker-controlled: verify ACTUAL inflated bytes by
    // trial-inflating every stored entry with a hard output limit
    try {
      verifyActualZipSize(buf, MAX_UNCOMPRESSED_BYTES);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("[zip]")) {
        throw new Error("That workbook expands too large when decompressed — over the 64 MB limit.");
      }
      throw err;
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
          vals.push(cellText(r.values?.[c]));
        }
        grid.push(vals);
      });
      tables[ws.name] = grid;
    });
    return { kind: "xlsx", tables };
  }

  throw new Error("Unsupported file type — use .csv or .xlsx (legacy .xls isn't supported).");
}
