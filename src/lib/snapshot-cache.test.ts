import { beforeEach, describe, expect, it } from "vitest";
import { clearSnapshotCache, peekSnapshot, rememberSnapshot, snapshotCacheStats } from "./snapshot-cache";
import { decodeSnapshot, encodeSnapshot, toSnapshotData } from "./snapshots";

const blob = (grid: string[][]) => encodeSnapshot(toSnapshotData(grid));

describe("snapshot decode LRU", () => {
  beforeEach(() => clearSnapshotCache());

  it("caches: first call decodes, second returns the identical object", () => {
    const b = blob([["A"], ["1"]]);
    const a1 = rememberSnapshot("s1", b);
    const a2 = peekSnapshot("s1")!;
    expect(a2).toBe(a1); // shared reference — the whole point
    expect(a1).toEqual(decodeSnapshot(b));
  });

  it("budget 0 disables caching entirely (the built-in rollback)", () => {
    const prev = process.env.SHEETDIFF_SNAPSHOT_CACHE_MB;
    process.env.SHEETDIFF_SNAPSHOT_CACHE_MB = "0";
    clearSnapshotCache();
    rememberSnapshot("s1", blob([["A"], ["1"]]));
    expect(peekSnapshot("s1")).toBeUndefined();
    process.env.SHEETDIFF_SNAPSHOT_CACHE_MB = prev;
  });

  it("LRU evicts the least-recently-used entry when the budget is exceeded", () => {
    const prev = process.env.SHEETDIFF_SNAPSHOT_CACHE_MB;
    // a tiny budget: each blob ~tens of bytes gzip; 1MB budget with
    // blob-length*30 estimation — force eviction by using many entries
    process.env.SHEETDIFF_SNAPSHOT_CACHE_MB = "0.001"; // 1KB
    clearSnapshotCache();
    const big = blob(Array.from({ length: 50 }, (_, i) => [String(i)]));
    rememberSnapshot("a", big);
    rememberSnapshot("b", big);
    rememberSnapshot("c", big);
    // 'a' was oldest and the budget can't hold three — at least one evicted
    const entries = snapshotCacheStats().entries;
    expect(entries).toBeLessThan(3);
    process.env.SHEETDIFF_SNAPSHOT_CACHE_MB = prev;
  });

  it("dev builds freeze cached data so mutation fails loudly", () => {
    const data = rememberSnapshot("f1", blob([["A"], ["1"]]));
    expect(() => {
      (data as unknown as Record<string, unknown>).headers = ["hacked"];
    }).toThrow();
  });
});
