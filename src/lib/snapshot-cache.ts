import type { SnapshotData } from "./diff/engine";
import { decodeSnapshot } from "./snapshots";

/**
 * Per-snapshot decode LRU. Snapshots are write-once: every id maps to a
 * blob that can never change, so a cached decoded grid is correct forever —
 * no invalidation exists. Decode is ~98% of the pending-resolver's cost
 * (measured 609ms cold vs 1ms warm on a 36-tab tracker), and the same ids
 * are re-decoded at seven call sites (sheet page, dashboard, digest, all
 * three export routes, ackAllUnentered).
 *
 * Budget: gzip bytes × ~30 as the decoded-JSON estimate; default 64MB;
 * SHEETDIFF_SNAPSHOT_CACHE_MB=0 disables (the built-in rollback).
 */

interface Entry {
  data: SnapshotData;
  estimatedBytes: number;
}

const globalForCache = globalThis as unknown as {
  __sheetdiffSnapCache?: Map<string, Entry>;
};

function cache(): Map<string, Entry> {
  if (!globalForCache.__sheetdiffSnapCache) {
    globalForCache.__sheetdiffSnapCache = new Map();
  }
  return globalForCache.__sheetdiffSnapCache;
}

function budget(): number {
  const mb = Number(process.env.SHEETDIFF_SNAPSHOT_CACHE_MB ?? 64);
  return Number.isFinite(mb) ? mb * 1024 * 1024 : 64 * 1024 * 1024;
}

/** Decode (or fetch cached) a snapshot. The returned object is SHARED —
 *  callers must treat it as read-only (dev builds deep-freeze it so a
 *  mutation fails loudly instead of corrupting every later read). */
export function rememberSnapshot(id: string, blob: Buffer): SnapshotData {
  const m = cache();
  const hit = m.get(id);
  if (hit) {
    m.delete(id);
    m.set(id, hit); // refresh LRU recency
    return hit.data;
  }
  const data = decodeSnapshot(blob);
  const estimatedBytes = blob.length * 30;
  const b = budget();
  if (b > 0 && estimatedBytes <= b * 0.4) {
    // evict oldest entries until the new one fits
    let total = [...m.values()].reduce((n, e) => n + e.estimatedBytes, 0);
    while (total + estimatedBytes > b && m.size > 0) {
      const oldestKey = m.keys().next().value as string;
      const oldest = m.get(oldestKey);
      if (oldest) total -= oldest.estimatedBytes;
      m.delete(oldestKey);
    }
    m.set(id, { data: frozen(data), estimatedBytes });
  }
  return data;
}

/** Cached read without a blob; hit refreshes recency. */
export function peekSnapshot(id: string): SnapshotData | undefined {
  const m = cache();
  const hit = m.get(id);
  if (hit) {
    m.delete(id);
    m.set(id, hit);
    return hit.data;
  }
  return undefined;
}

export function snapshotCacheStats(): { entries: number; estimatedBytes: number } {
  const m = cache();
  return {
    entries: m.size,
    estimatedBytes: [...m.values()].reduce((n, e) => n + e.estimatedBytes, 0),
  };
}

export function clearSnapshotCache(): void {
  cache().clear();
}

function frozen<T>(value: T): T {
  // freeze in PRODUCTION too: a shared-object mutation corrupts every later
  // read process-wide — the one-time freeze cost (microseconds per snapshot)
  // is cheaper than that class of bug
  return deepFreeze(value);
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object" && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj as Record<string, unknown>)) deepFreeze(v);
  }
  return obj;
}
