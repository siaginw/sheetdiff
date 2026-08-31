import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { parseImportFile } from "./import";
import { toSnapshotData } from "./snapshots";
import { runChecks, computeFootage } from "./checks";

function csvFile(text: string): File {
  return new File([text], "gis-export.csv", { type: "text/csv" });
}

describe("parseImportFile (CSV)", () => {
  it("parses a GIS csv export into a grid", async () => {
    const csv = [
      "Shot,Start Station,End Station,Type",
      "S1,0,500,plow",
      "S2,500,14800,bore",
      "S3,14800,15743,plow",
    ].join("\n");
    const { kind, tables } = await parseImportFile(csvFile(csv));
    expect(kind).toBe("csv");
    const data = toSnapshotData(tables.csv);
    expect(data.headers).toEqual(["Shot", "Start Station", "End Station", "Type"]);
    expect(data.rows).toHaveLength(3);
    expect(data.rows[2]).toEqual(["S3", "14800", "15743", "plow"]);
  });

  it("drops empty rows anywhere in the sheet, not just trailing", async () => {
    const csv = "A,B\n1,2\n,\n,";
    const { tables } = await parseImportFile(csvFile(csv));
    expect(toSnapshotData(tables.csv).rows).toEqual([["1", "2"]]);
  });

  it("rejects unsupported files", async () => {
    const bad = new File(["x"], "export.pdf");
    await expect(parseImportFile(bad)).rejects.toThrow(/Unsupported/);
  });
});

describe("parseImportFile (XLSX)", () => {
  // mirrors real production trackers: formula cells for computed columns,
  // adder rows reusing a bore's range, and blank padded rows
  async function trackerFile(): Promise<File> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("US2-PE-001");
    ws.addRow(["Activity", "Start STA", "End STA", "Total Footage"]);
    ws.addRow(["Plow", 0, 100, { formula: "C2-B2", result: 100 }]);
    ws.addRow([]); // blank spacer
    ws.addRow(["Bore", 100, 200, { formula: "C4-B4", result: 100 }]);
    ws.addRow(["Cobble Adder", 100, 200, { formula: "C5-B5", result: 100 }]); // billing overlay
    ws.addRow(["48 Handhole", 200, 200, 1]); // zero-length structure row
    ws.addRow(["Plow", 200, 300, { formula: "C7-B7", result: 300 - 200 }]);
    const buf = await wb.xlsx.writeBuffer();
    return new File([buf], "tracker.xlsx");
  }

  it("resolves formula cells to their computed results", async () => {
    const { tables } = await parseImportFile(await trackerFile());
    const data = toSnapshotData(tables["US2-PE-001"]);
    expect(data.headers[3]).toBe("Total Footage");
    expect(data.rows[0][3]).toBe("100"); // formula → result, never "[object Object]"
    expect(data.rows.some((r) => r.join("").includes("object"))).toBe(false);
    // blank spacer row is gone
    expect(data.rows).toHaveLength(5);
  });

  it("treats adder rows as overlays — no overlap finding, no footage", async () => {
    const { tables } = await parseImportFile(await trackerFile());
    const data = toSnapshotData(tables["US2-PE-001"]);
    const findings = runChecks([{ tabTitle: "US2-PE-001", data, keyColumn: null }]);
    expect(findings).toEqual([]); // the Cobble Adder overlap must not fire
    const f = computeFootage(data);
    expect(f.ft).toBe(300); // 0-100 + 100-200 + 200-300
    expect(f.shots).toBe(3); // handhole isn't footage
    expect(f.handholes).toBe(1); // counted as a structure
  });

  it("accounts GAP rows as known unworked footage, never placed", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("PE");
    ws.addRow(["Activity", "Start STA", "End STA"]);
    ws.addRow(["Plow", 0, 500]);
    ws.addRow(["GAP", 500, 620]); // 120 ft booked as a known gap
    ws.addRow(["Bore", 620, 900]);
    const buf = await wb.xlsx.writeBuffer();
    const { tables } = await parseImportFile(new File([buf], "tracker.xlsx"));
    const data = toSnapshotData(tables.PE);
    const f = computeFootage(data);
    expect(f.ft).toBe(780); // 500 + 260 — the gap is NOT placed footage
    expect(f.gaps).toEqual({ count: 1, ft: 120 });
    // and the chain flows through the GAP row without flagging it
    expect(runChecks([{ tabTitle: "PE", data, keyColumn: null }])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* zip guard: crafted archives (bombs, lies)                           */
/* ------------------------------------------------------------------ */

import zlib from "node:zlib";

/** Hand-built zip: local headers + data + central directory + EOCD, with
 *  knobs for the exact lies attackers write. */
function craftZip(opts: {
  entries: { name: string; uncompressed: Buffer }[];
  /** local-header sizes zeroed + flag bit 3 (streamed/descriptor entry) */
  descriptor?: boolean;
  /** lie in the central directory's uncompressed-size fields */
  declaredUncompressed?: number;
  /** lie in the EOCD's entry count (JSZip ignores it and walks signatures) */
  eocdCount?: number;
}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const e of opts.entries) {
    offsets.push(offset);
    const comp = zlib.deflateRawSync(e.uncompressed);
    const nameBuf = Buffer.from(e.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(opts.descriptor ? 0x0008 : 0, 6); // flags: bit 3
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date
    local.writeUInt32LE(0, 14); // crc
    local.writeUInt32LE(opts.descriptor ? 0 : comp.length, 18); // comp size
    local.writeUInt32LE(opts.descriptor ? 0 : e.uncompressed.length, 22); // uncomp size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, comp);
    offset += 30 + nameBuf.length + comp.length;
  }
  for (let i = 0; i < opts.entries.length; i++) {
    const e = opts.entries[i]!;
    const nameBuf = Buffer.from(e.name, "utf8");
    const comp = zlib.deflateRawSync(e.uncompressed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(8, 10); // method
    c.writeUInt32LE(opts.declaredUncompressed ?? e.uncompressed.length, 24); // declared uncompressed
    c.writeUInt32LE(comp.length, 20); // compressed size (truthful — needed to walk)
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt16LE(0, 30);
    c.writeUInt16LE(0, 32);
    c.writeUInt32LE(offsets[i]!, 42);
    central.push(c, nameBuf);
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(opts.eocdCount ?? opts.entries.length, 8); // entries this disk
  eocd.writeUInt16LE(opts.eocdCount ?? opts.entries.length, 10); // total entries
  eocd.writeUInt32LE(centralBuf.length, 12); // central directory size
  eocd.writeUInt32LE(offset, 16); // central directory offset
  eocd.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...parts, centralBuf, eocd]);
}

const bomb = (mb: number) => Buffer.alloc(mb * 1024 * 1024, 0x41); // DEFLATE compresses ~1000:1

describe("parseImportFile (XLSX zip guard)", () => {
  it("rejects a data-descriptor bomb (flag bit 3, zeroed local sizes) with the friendly message", async () => {
    const zip = craftZip({
      entries: [
        { name: "xl/worksheets/sheet1.xml", uncompressed: bomb(70) },
      ],
      descriptor: true,
      declaredUncompressed: 1000,
    });
    await expect(parseImportFile(new File([new Uint8Array(zip)], "bomb.xlsx"))).rejects.toThrow(/expands too large/);
  });

  it("rejects an EOCD count lie (entries hidden past the declared count — JSZip walks them anyway)", async () => {
    const zip = craftZip({
      entries: [
        { name: "[Content_Types].xml", uncompressed: Buffer.from("<Types/>") },
        { name: "xl/worksheets/sheet1.xml", uncompressed: bomb(70) },
      ],
      declaredUncompressed: 100,
      eocdCount: 1, // the bomb is "not there"
    });
    await expect(parseImportFile(new File([new Uint8Array(zip)], "lie.xlsx"))).rejects.toThrow(/expands too large|corrupt or lies/);
  });

  it("survives a truncated deflate stream with a clean error (no raw zlib internals)", async () => {
    const zip = craftZip({ entries: [{ name: "a.xml", uncompressed: Buffer.from("hello") }] });
    const truncated = zip.subarray(0, zip.length - 8); // chop into the central dir/EOCD
    await expect(parseImportFile(new File([new Uint8Array(truncated)], "cut.xlsx"))).rejects.toThrow(/xlsx|zip|central/i);
  });
});
