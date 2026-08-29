/**
 * CSV formula-injection guard: values beginning with =, +, -, @ (or a tab/CR)
 * would execute as formulas when the CSV is opened in Excel/Sheets, so they
 * get a leading apostrophe that neutralizes them while keeping the text.
 */
export function csvSafe(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}
