/**
 * Value normalization used by the diff engine.
 *
 * Sheets are edited by humans, so superficially different values must not be
 * reported as changes: "40" vs "40.00" vs " 40 " vs "$40" are the same number.
 * Everything here is deliberately conservative — when unsure, treat values as
 * different (a missed change is worse than an extra one being flagged).
 */

/** Trim a cell value; nullish -> empty string. */
export function norm(value: unknown): string {
  return String(value ?? "").trim();
}

const CURRENCY_RE = /^[$€£¥]\s*/;
const THOUSANDS_RE = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;

/**
 * Parse a human-typed number, tolerating currency prefixes, thousands
 * separators and surrounding whitespace. Returns null when the string is not
 * confidently a number (empty, NaN, Infinity, multiple dots...).
 */
export function parseNumberLike(s: string): number | null {
  let t = norm(s);
  if (t === "") return null;
  t = t.replace(CURRENCY_RE, "");
  if (THOUSANDS_RE.test(t)) t = t.replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** True when two raw cell values should be considered equal. */
export function sameValue(a: unknown, b: unknown): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  const pa = parseNumberLike(na);
  const pb = parseNumberLike(nb);
  if (pa !== null && pb !== null) return pa === pb;
  return false;
}

/**
 * Canonical form of a row key: trimmed, case-folded, numerically normalized
 * ("007" and "7" are the same key, "jake" and "Jake" are the same key).
 */
export function normalizeKey(value: unknown): string {
  const t = norm(value).toLowerCase();
  const p = parseNumberLike(t);
  return p !== null ? String(p) : t;
}

/** Stable hash of a row restricted to the given column indices. */
export function rowHash(row: string[], cols: number[]): string {
  let h = "";
  for (const c of cols) h += norm(row[c]) + "\u0000";
  return h;
}

/** 0 -> "A", 25 -> "Z", 26 -> "AA" (spreadsheet column letters). */
export function colLetter(i: number): string {
  let s = "";
  let n = i;
  while (n >= 0) {
    s = String.fromCharCode((n % 26) + 65) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

/**
 * Composite row identity: normalized values of `cols` joined by "·",
 * POSITIONALLY — blank parts stay as empty slots so ["Plow","","15743"] and
 * ["Plow","15743",""] are DIFFERENT rows. All-blank -> "" (no identity).
 * The one definition used by engine matching, dupe checks, and trace.
 */
export function compositeKey(row: readonly string[], cols: readonly number[]): string {
  const parts = cols.map((c) => normalizeKey(row[c]));
  return parts.every((v) => v === "") ? "" : parts.join("·");
}

/** FNV-1a — tiny stable hash for row identities when no key column exists. */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
