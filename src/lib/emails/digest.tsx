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
  return (
    <Html>
      <Head />
      <Preview>
        {totalUnresolved > 0
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
            {totalChecks > 0 ? ` ${totalChecks} check finding${totalChecks === 1 ? "" : "s"} need a look.` : ""}
          </Text>

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
                ) : (
                  <span style={{ color: "#1a7f37" }}>✓ up to date since collection</span>
                )}
              </Text>

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
