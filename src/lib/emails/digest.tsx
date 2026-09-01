import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";

export interface DigestChange {
  tab: string;
  description: string;
}

export interface DigestSheet {
  title: string;
  url: string;
  changes: number;
  detail: { added: number; removed: number; changed: number };
  unresolved: number;
  sampleChanges: DigestChange[];
  checkCount: number;
  topChecks: string[];
  notes: { body: string; when: string }[];
  /** total footage change since collection, when station columns exist */
  footageDelta: number;
  /** this week's dated footage + week-over-week delta, when dates exist */
  weekFt: number | null;
  weekDeltaFt: number | null;
  /** placed / designed / remaining from TOTALS, when it exists */
  placedFt: number | null;
  designedFt: number | null;
  remainingFt: number | null;
  /** permit exposure from the tracker join — null when the sheet carries no
   *  Permit Tracker tab (vocabulary-gated, like every other join) */
  permitCounts: { unapprovedCrossings: number; designedNoPermit: number } | null;
  /** stoppage-log context for the digest week — null when there is no log */
  stoppage: { weekCount: number; exemplar: string; quietDaysBehind: number | null } | null;
  /** "3d ago" — stale captures are a pipeline problem, not "all up to date" */
  lastSnapshotAgo: string | null;
  /** schedule is off — the sheet isn't capturing by choice, so an old snapshot is expected */
  paused?: boolean;
}

export function DigestEmail({
  name,
  appUrl,
  sheets,
}: {
  name: string;
  appUrl: string;
  sheets: DigestSheet[];
}) {
  const totalUnresolved = sheets.reduce((n, s) => n + s.unresolved, 0);
  const totalChecks = sheets.reduce((n, s) => n + s.checkCount, 0);
  const staleSheets = sheets.filter((s) => s.lastSnapshotAgo);
  return (
    <Html>
      <Head />
      <Preview>
        {staleSheets.length > 0
          ? `⚠ ${staleSheets.length} sheet${staleSheets.length === 1 ? "" : "s"} may have stale data${totalUnresolved > 0 ? ` · ${totalUnresolved} to enter` : ""}`
          : totalUnresolved > 0
            ? `${totalUnresolved} change${totalUnresolved === 1 ? "" : "s"} waiting to be collected`
            : "all sheets up to date since collection"}
      </Preview>
      <Body style={{ fontFamily: "ui-sans-serif, system-ui, sans-serif", margin: 0, padding: "24px 0", background: "#f6f8fa" }}>
        <Container style={{ maxWidth: 560, margin: "0 auto" }}>
          <Text style={{ fontSize: 12, color: "#57606a", margin: "0 0 8px", fontFamily: "ui-monospace, monospace" }}>
            sheetdiff · daily digest
          </Text>
          <Heading as="h1" style={{ fontSize: 20, margin: "0 0 4px", color: "#1f2328" }}>
            Good morning{name ? `, ${name}` : ""}
          </Heading>
          <Text style={{ fontSize: 14, color: "#57606a", margin: "0 0 20px" }}>
            {totalUnresolved > 0
              ? `${totalUnresolved} change${totalUnresolved === 1 ? "" : "s"} across ${sheets.length} sheet${sheets.length === 1 ? "" : "s"} since the last collection.`
              : "Every tracked sheet is up to date since its last collection."}
            {totalChecks > 0 ? ` ${totalChecks} check finding${totalChecks === 1 ? "" : "s"} need${totalChecks === 1 ? "s" : ""} a look.` : ""}
          </Text>

          {staleSheets.length > 0 ? (
            <div style={{ background: "#fff8c5", border: "1px solid #d4a72c", borderRadius: 8, padding: "10px 14px", margin: "0 0 16px" }}>
              <Text style={{ fontSize: 13, margin: 0, color: "#4d3800", fontWeight: 600 }}>
                ⚠ {staleSheets.length} sheet{staleSheets.length === 1 ? "" : "s"} hasn&rsquo;t synced recently — the numbers below may be out of date.
              </Text>
              <Text style={{ fontSize: 12, margin: "4px 0 0", color: "#4d3800" }}>
                Last snapshot{staleSheets.length === 1 ? "" : "s"}: {staleSheets.map((s) => `${s.title} (${s.lastSnapshotAgo})`).join(", ")}. Check that SheetDiff is running and connected to Google.
              </Text>
            </div>
          ) : null}

          {sheets.map((s) => (
            <Section key={s.title} style={{ background: "#ffffff", border: "1px solid #d1d9e0", borderRadius: 8, padding: "16px 20px", margin: "0 0 16px" }}>
              <Text style={{ fontSize: 15, fontWeight: 600, margin: "0 0 2px", color: "#1f2328" }}>
                {s.title}
              </Text>
              <Text style={{ fontSize: 13, margin: "0 0 10px", fontFamily: "ui-monospace, monospace" }}>
                {s.changes > 0 ? (
                  <>
                    <span style={{ color: "#1a7f37" }}>+{s.detail.added}</span>{" "}
                    <span style={{ color: "#cf222e" }}>−{s.detail.removed}</span>{" "}
                    <span style={{ color: "#9a6700" }}>~{s.detail.changed}</span>{" "}
                    <span style={{ color: "#57606a" }}>since collection</span>
                    {s.unresolved < s.changes ? (
                      <span style={{ color: "#57606a" }}> ({s.unresolved} still to enter)</span>
                    ) : null}
                  </>
                ) : s.lastSnapshotAgo ? (
                  // stale data can never certify "up to date" — this is the lie the flag exists to catch
                  <span style={{ color: "#9a6700", fontWeight: 600 }}>
                    ⚠ last snapshot {s.lastSnapshotAgo} — data may be stale
                  </span>
                ) : (
                  <span style={{ color: "#1a7f37" }}>✓ up to date since collection</span>
                )}
                {s.paused ? <span style={{ color: "#57606a" }}> · paused</span> : null}
                {s.weekFt !== null ? (
                  <span style={{ color: "#57606a" }}>
                    {" · this week "}{s.weekFt.toLocaleString("en-US")} ft
                    {s.weekDeltaFt !== null && s.weekDeltaFt !== 0 ? (
                      <span style={{ color: s.weekDeltaFt > 0 ? "#1a7f37" : "#cf222e" }}>
                        {" ("}{s.weekDeltaFt > 0 ? "+" : "−"}{Math.abs(s.weekDeltaFt).toLocaleString("en-US")}{")"}
                      </span>
                    ) : null}
                  </span>
                ) : null}
                {s.remainingFt !== null && s.placedFt !== null && s.designedFt ? (
                  <span style={{ color: "#57606a" }}>
                    {" · "}{s.placedFt.toLocaleString("en-US")}/{s.designedFt.toLocaleString("en-US")} ft placed · {s.remainingFt.toLocaleString("en-US")} ft remaining
                  </span>
                ) : null}
                {s.footageDelta !== 0 ? (
                  <>
                    {" · "}
                    <span style={{ color: s.footageDelta > 0 ? "#1a7f37" : "#cf222e" }}>
                      {s.footageDelta > 0 ? "+" : "−"}
                      {Math.abs(s.footageDelta).toLocaleString("en-US")} ft footage
                    </span>
                  </>
                ) : null}
              </Text>

              {/* permit + stoppage highlights — the same detectors the sheet and
                  report pages run, two or three lines beside the weekly position */}
              {s.permitCounts && s.permitCounts.unapprovedCrossings + s.permitCounts.designedNoPermit > 0 ? (
                <div style={{ background: "#fff8c5", border: "1px solid #d4a72c", borderRadius: 6, padding: "6px 12px", margin: "0 0 8px" }}>
                  {s.permitCounts.unapprovedCrossings > 0 ? (
                    <Text style={{ fontSize: 12, margin: "3px 0", color: "#4d3800" }}>
                      ⚠ {s.permitCounts.unapprovedCrossings} crossing{s.permitCounts.unapprovedCrossings === 1 ? "" : "s"} placed under permits the tracker hasn&rsquo;t approved
                    </Text>
                  ) : null}
                  {s.permitCounts.designedNoPermit > 0 ? (
                    <Text style={{ fontSize: 12, margin: "3px 0", color: "#4d3800" }}>
                      ⚠ {s.permitCounts.designedNoPermit} package{s.permitCounts.designedNoPermit === 1 ? "" : "s"} designed with no permit listed
                    </Text>
                  ) : null}
                </div>
              ) : null}
              {s.stoppage && (s.stoppage.quietDaysBehind !== null || s.stoppage.weekCount > 0) ? (
                <div style={{ background: "#f0f6ff", borderRadius: 6, padding: "6px 12px", margin: "0 0 8px" }}>
                  {s.stoppage.quietDaysBehind !== null ? (
                    <Text style={{ fontSize: 12, margin: "3px 0", color: "#0969da" }}>
                      ⚠ stoppage log looks quiet — {s.stoppage.quietDaysBehind} day{s.stoppage.quietDaysBehind === 1 ? "" : "s"} behind the newest completed work. Is the log being kept?
                    </Text>
                  ) : (
                    <Text style={{ fontSize: 12, margin: "3px 0", color: "#0969da" }}>
                      ⛔ {s.stoppage.weekCount} stoppage{s.stoppage.weekCount === 1 ? "" : "s"} logged this week{s.stoppage.exemplar ? ` — ${s.stoppage.exemplar}` : ""}
                    </Text>
                  )}
                </div>
              ) : null}

              {s.sampleChanges.length > 0 ? (
                <ul style={{ margin: "0 0 10px", padding: 0, listStyle: "none" }}>
                  {s.sampleChanges.slice(0, 8).map((c, i) => (
                    <li key={i} style={{ fontSize: 13, color: "#1f2328", padding: "3px 0", borderBottom: i < 7 ? "1px solid #f0f2f4" : "none" }}>
                      <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: "#57606a" }}>{c.tab}</span>
                      {" — "}
                      {c.description}
                    </li>
                  ))}
                </ul>
              ) : null}

              {s.notes.length > 0 ? (
                <div style={{ background: "#fff8c5", borderRadius: 6, padding: "8px 12px", margin: "0 0 10px" }}>
                  {s.notes.slice(0, 3).map((n, i) => (
                    <Text key={i} style={{ fontSize: 12, margin: "2px 0", color: "#4d3800" }}>
                      🗒 {n.body}
                    </Text>
                  ))}
                </div>
              ) : null}

              {s.topChecks.length > 0 ? (
                <div style={{ background: "#ffebe9", borderRadius: 6, padding: "8px 12px" }}>
                  {s.topChecks.slice(0, 3).map((c, i) => (
                    <Text key={i} style={{ fontSize: 12, margin: "2px 0", color: "#660000" }}>
                      ⚠ {c}
                    </Text>
                  ))}
                  {s.checkCount > 3 ? (
                    <Text style={{ fontSize: 11, margin: "4px 0 0", color: "#660000" }}>+{s.checkCount - 3} more…</Text>
                  ) : null}
                </div>
              ) : null}
            </Section>
          ))}

          <Hr style={{ borderColor: "#d1d9e0", margin: "8px 0 16px" }} />
          <Link href={appUrl} style={{ fontSize: 13, color: "#0969da" }}>
            Open SheetDiff to review and mark as collected
          </Link>
          <Text style={{ fontSize: 11, color: "#8c959f", margin: "12px 0 0" }}>
            Notation: <span style={{ color: "#1a7f37" }}>+N</span> rows added,{" "}
            <span style={{ color: "#cf222e" }}>−N</span> removed,{" "}
            <span style={{ color: "#9a6700" }}>~N</span> changed — since the last collected
            snapshot.
          </Text>
          <Text style={{ fontSize: 11, color: "#8c959f", margin: "12px 0 0" }}>
            Sent by your local SheetDiff instance while it&rsquo;s running.{" "}
            <Link href={`${appUrl}/`} style={{ color: "#8c959f" }}>
              Change digest settings
            </Link>
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
