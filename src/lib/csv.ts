/**
 * CSV formula-injection guard: values beginning with =, +, -, @ (or a tab/CR)
 * would execute as formulas when the CSV is opened in Excel/Sheets, so they
 * get a leading apostrophe that neutralizes them while keeping the text.
 * A pure numeric token is exempt: "-65" or "-1234.56" is footage lost to a
 * correction, not a formula, and the apostrophe would corrupt it on re-import.
 */
const NUMERIC_TOKEN = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export function csvSafe(value: string): string {
  if (NUMERIC_TOKEN.test(value)) return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}
