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
    expect(f.ft).toBe(300); // 0-100 + 100-200 + 200-300; handhole adds 0
    expect(f.shots).toBe(4);
  });
});
