import type { SnapshotData } from "./diff/engine";
import { norm } from "./diff/normalize";
import { parseCompletedDate, detectDateColumn } from "./production";

/**
 * Permit-status join: the tracker's own Permit Tracker tab (permit number →
 * status/agency) crossed with what the crews say they placed. Pure — the
 * sheet page feeds it the permit tab, the TOTALS tab, and the working tabs'
 * latest snapshots. Everything is header-vocabulary-driven like the rest of
 * the production analytics: a sheet without the vocabulary no-ops silently
 * instead of guessing.
 */

const PERMIT_TITLE_RE = /permit/i;
const PERMIT_NUM_RE = /permit\s*(no\.?|#|number)?\s*$/i;
const STATUS_RE = /^status\b|\bstatus/i;
const AGENCY_RE = /agenc|jurisdiction|city|county|utility|municipal/i;
const SUBMITTED_RE = /submit/i;
/** status vocabulary that means the permit is good to work under */
const PERMIT_APPROVED_RE = /approv|issu|releas|grant|clear|accept/i;

/** Title-only prefilter so pages avoid decoding blobs of unrelated tabs. */
export function isPermitTabTitle(title: string): boolean {
  return PERMIT_TITLE_RE.test(title);
}

/** The Permit Tracker tab: titled like one AND carrying permit vocabulary —
 *  a permit-number column plus at least one of status/agency/submitted. The
 *  header check keeps a tab named "Permit Tracker" that logs something else
 *  from activating the join with garbage columns. */
export function detectPermitTab(
  tabs: { title: string; data: SnapshotData }[],
): { title: string; data: SnapshotData } | null {
  for (const t of tabs) {
    if (!PERMIT_TITLE_RE.test(t.title)) continue;
    const headers = t.data.headers.map((h) => norm(h));
    const hasPermitCol = headers.some((h) => PERMIT_NUM_RE.test(h));
    const vocab = headers.filter((h) => STATUS_RE.test(h) || AGENCY_RE.test(h) || SUBMITTED_RE.test(h)).length;
    if (hasPermitCol && vocab >= 1) return t;
  }
  return null;
}

export interface PermitRecord {
  permit: string;
  status: string;
  agency: string;
  /** parsed Submitted date, when the tracker carries one */
  submittedOn: Date | null;
  submittedRaw: string;
  row: number;
}

const key = (v: unknown) => norm(v).toLowerCase();

/** Permit Number → tracker record. Blank numbers are skipped; on a duplicate
 *  number the FIRST tracker row wins (stable, and hand-maintained logs list
 *  the canonical row first). */
export function buildPermitIndex(data: SnapshotData): Map<string, PermitRecord> {
  const col = (re: RegExp): number => data.headers.findIndex((h) => re.test(norm(h)));
  const numCol = col(PERMIT_NUM_RE);
  const statusCol = col(STATUS_RE);
  const agencyCol = col(AGENCY_RE);
  const subCol = col(SUBMITTED_RE);
  const index = new Map<string, PermitRecord>();
  if (numCol === -1) return index;
  data.rows.forEach((r, i) => {
    const permit = norm(r[numCol]);
    if (permit === "") return;
    const k = key(permit);
    if (index.has(k)) return;
    index.set(k, {
      permit,
      status: statusCol >= 0 ? norm(r[statusCol]) : "",
      agency: agencyCol >= 0 ? norm(r[agencyCol]) : "",
      submittedOn: subCol >= 0 ? parseCompletedDate(r[subCol]) : null,
      submittedRaw: subCol >= 0 ? norm(r[subCol]) : "",
      row: i + 1,
    });
  });
  return index;
}

/** A permit status that allows work: Approved/Issued/Released… Blank counts
 *  as NOT approved — absence of a status can't wave work through (the same
 *  rule the GIS check applies to billing). */
export const PERMIT_NEGATIVE_RE = /denied|revoked|suspend|reject|pending|nots|held|withdraw|expired|return/i;

export function permitIsApproved(status: string): boolean {
  // deny-list FIRST: sheet-controlled status text saying "Not Issued",
  // "Denied", "Pending" must never read as approved — the approve vocabulary
  // is broad ("issu" matches "Not Issued") and would fail open
  if (PERMIT_NEGATIVE_RE.test(status)) return false;
  return /approv|issu|releas|grant|clear|accept/i.test(status);
}

export type PermitFindingKind = "designed-no-permit" | "placed-under-unapproved" | "submitted-aging";

export interface PermitFinding {
  kind: PermitFindingKind;
  detail: string;
  meta?: string;
}

const ft = (n: number) => n.toLocaleString("en-US");

/** Cross the tracker against the sheet: TOTALS packages designed with no
 *  permit listed, PE rows placed under a permit the tracker hasn't approved,
 *  and tracker permits aging in Submitted. `peTabs` should be the DEDUPED
 *  latest data of the working tabs — a copy tab must not double-report the
 *  same placed row. */
export function permitFindings(input: {
  permitTab: SnapshotData;
  totals?: SnapshotData | null;
  peTabs: { title: string; data: SnapshotData }[];
  now?: number;
  agingThresholdDays?: number;
}): PermitFinding[] {
  const now = input.now ?? Date.now();
  const agingThresholdDays = input.agingThresholdDays ?? 30;
  const index = buildPermitIndex(input.permitTab);
  if (index.size === 0) return [];
  const out: PermitFinding[] = [];

  // 1. TOTALS: designed footage whose permit cell is blank — work designed
  //    with no permit path at all (the conversation to have BEFORE crews are
  //    standing on the shot). No permit column on TOTALS = nothing to judge.
  if (input.totals) {
    const designedCol = input.totals.headers.findIndex((h) => /designed/i.test(norm(h)));
    const permitCol = input.totals.headers.findIndex((h) => PERMIT_NUM_RE.test(norm(h)));
    if (designedCol >= 0 && permitCol >= 0) {
      for (const row of input.totals.rows) {
        const designed = Number(norm(row[designedCol]).replace(/,/g, ""));
        if (!Number.isFinite(designed) || designed <= 0) continue;
        if (norm(row[permitCol]) !== "") continue;
        const nameCell = row.find((v, i) => i !== designedCol && i !== permitCol && norm(v) !== "");
        out.push({
          kind: "designed-no-permit",
          detail: `${norm(nameCell ?? "")}: ${ft(designed)} ft designed, no permit listed in TOTALS`,
          meta: "designed work with no permit path",
        });
      }
    }
  }

  // 2. working tabs: rows PLACED (a readable Date Complete) whose Permit
  //    Package value is missing from the tracker or not approved yet
  for (const { title, data } of input.peTabs) {
    const permitCol = data.headers.findIndex((h) => /permit/i.test(norm(h)));
    if (permitCol === -1) continue;
    const dateCol = detectDateColumn(data);
    if (dateCol === null) continue; // the tab can't say what's placed — don't guess
    data.rows.forEach((r, i) => {
      const permitVal = norm(r[permitCol]);
      if (permitVal === "") return; // untagged rows are the TOTALS finding's job
      const completed = parseCompletedDate(r[dateCol]);
      if (completed === null) return; // not placed yet
      const rec = index.get(key(permitVal));
      if (rec && permitIsApproved(rec.status)) return; // fine to have placed
      const statusText = rec
        ? rec.status === ""
          ? "no status in the tracker"
          : `status "${rec.status}" — not approved`
        : "not in the Permit Tracker at all";
      out.push({
        kind: "placed-under-unapproved",
        detail: `${title} row ${i + 1}: placed under ${permitVal} — ${statusText}`,
        meta: rec?.agency ? `agency: ${rec.agency}` : undefined,
      });
    });
  }

  // 3. the tracker itself: submitted and aging past the threshold without
  //    approval — the chase list
  for (const rec of index.values()) {
    if (permitIsApproved(rec.status)) continue;
    if (!rec.submittedOn) continue;
    const days = Math.floor((now - rec.submittedOn.getTime()) / 86_400_000);
    if (days <= agingThresholdDays) continue;
    out.push({
      kind: "submitted-aging",
      detail: `${rec.permit}${rec.agency ? ` · ${rec.agency}` : ""} — submitted ${days}d ago, ${
        rec.status === "" ? "still no status" : `still "${rec.status}"`
      }`,
      meta: "chase the agency",
    });
  }

  return out;
}
