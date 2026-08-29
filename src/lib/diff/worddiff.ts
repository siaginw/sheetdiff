import { diffWords } from "diff";

/**
 * Word-level diff for long cell values (notes, descriptions) where showing
 * whole old/new values hides the actual edit. Uses jsdiff's diffWords.
 */

export interface WordDiffSegment {
  text: string;
  kind: "same" | "removed" | "added";
}

/** Only worth a word diff when values are long enough to hide the change. */
export function shouldWordDiff(a: string, b: string): boolean {
  return a.length + b.length > 28 && a.toLowerCase() !== b.toLowerCase();
}

export function wordDiff(a: string, b: string): WordDiffSegment[] {
  return diffWords(a, b).map((p) => ({
    text: p.value,
    kind: p.added ? "added" : p.removed ? "removed" : "same",
  }));
}
