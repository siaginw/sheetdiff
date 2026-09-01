/**
 * Digest email rendering: the permit/stoppage highlight lines and the +N −N ~N
 * notation legend in the footer. Pure component test — @react-email/render
 * produces the same HTML sendDigestTo mails, no DB involved.
 */
import { describe, it, expect } from "vitest";
import { render } from "@react-email/render";
import { DigestEmail, type DigestSheet } from "./digest";

const base: DigestSheet = {
  title: "Springfield Tracker",
  url: "https://x",
  id: "sheet-1",
  changes: 0,
  detail: { added: 0, removed: 0, changed: 0 },
  unresolved: 0,
  sampleChanges: [],
  checkCount: 0,
  topChecks: [],
  notes: [],
  footageDelta: 0,
  weekFt: null,
  weekDeltaFt: null,
  placedFt: null,
  designedFt: null,
  remainingFt: null,
  permitCounts: null,
  stoppage: null,
  lastSnapshotAgo: null,
};

/** Rendered HTML with react-email's `<!-- -->` interpolation markers stripped,
 *  so assertions can read phrases that span a `{count}` hole. */
const renderSheets = async (sheets: DigestSheet[]) =>
  (await render(DigestEmail({ name: "Erin", appUrl: "http://app", sheets }))).replace(/<!-- -->/g, "");

describe("digest email: permit + stoppage highlight lines", () => {
  it("spells out unapproved crossings, designed-no-permit packages, and this week's stoppages", async () => {
    const html = await renderSheets([
      {
        ...base,
        permitCounts: { unapprovedCrossings: 2, designedNoPermit: 1 },
        stoppage: { weekCount: 3, exemplar: "waiting on utility locate", quietDaysBehind: null },
      },
    ]);
    expect(html).toContain("2 crossings placed under permits");
    expect(html).toContain("1 package designed with no permit listed");
    expect(html).toContain("3 stoppages logged this week");
    expect(html).toContain("waiting on utility locate");
  });

  it("the quiet-log warning replaces the this-week line when the log trails the work", async () => {
    const html = await renderSheets([
      { ...base, stoppage: { weekCount: 0, exemplar: "", quietDaysBehind: 52 } },
    ]);
    expect(html).toContain("stoppage log looks quiet");
    expect(html).toContain("52 days behind the newest completed work");
    expect(html).not.toContain("stoppage logged this week");
  });

  it("all-clear sheets carry no highlight lines — the vocabulary gates, the email stays quiet", async () => {
    const html = await renderSheets([
      { ...base, permitCounts: { unapprovedCrossings: 0, designedNoPermit: 0 }, stoppage: { weekCount: 0, exemplar: "", quietDaysBehind: null } },
    ]);
    expect(html).not.toContain("placed under permits");
    expect(html).not.toContain("stoppage");
    expect(html).not.toContain("quiet");
  });
});

describe("digest email: notation legend in the footer", () => {
  it("explains +N −N ~N in one line", async () => {
    const html = await renderSheets([base]);
    expect(html).toContain("+N");
    expect(html).toContain("−N");
    expect(html).toContain("~N");
    expect(html).toContain("since the last collected snapshot");
  });
});
