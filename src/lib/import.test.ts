import { describe, it, expect } from "vitest";
import { parseImportFile } from "./import";
import { toSnapshotData } from "./snapshots";

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

  it("drops trailing empty rows like the Sheets reader does", async () => {
    const csv = "A,B\n1,2\n,\n,";
    const { tables } = await parseImportFile(csvFile(csv));
    expect(toSnapshotData(tables.csv).rows).toEqual([["1", "2"]]);
  });

  it("rejects unsupported files", async () => {
    const bad = new File(["x"], "export.pdf");
    await expect(parseImportFile(bad)).rejects.toThrow(/Unsupported/);
  });
});
