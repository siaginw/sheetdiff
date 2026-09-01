# SheetDiff v0.4.0 — the accounting-grade release

**The numbers on a billing packet can cost real money.** v0.4 hardens every
computation path in SheetDiff with a five-agent accuracy audit — number
correctness, adversarial fuzzing, data integrity, cross-surface invariants,
and a forensic pass against a real 36-package utility production tracker —
then fixes everything it found. Every fix is enforced by a permanent test
suite (353 tests, 24 new), including a cross-surface invariant suite that
seeds one sheet and asserts the dashboard, sheet page, three CSVs, billing
page, report, and digest all show the same hand-computed numbers.

## The headline fixes

- **Compilation tabs can no longer double-bill.** Real trackers carry a "Line
  List" that re-lists the working tabs — sometimes reformatted (`2+14` for
  `214`, retyped crews, different widths). Cell-text dedup never matched those,
  and on the real tracker the configuration nearly **doubled invoiceable
  footage (910,210 ft vs the true 459,472 ft)**. Rows are now deduplicated by
  work identity — activity + parsed stations — with ownership decided once and
  applied to baselines and history, verified against the real file: PE-only
  and PE+Line-List export IDENTICAL billing packets.
- **Exports are byte-identical.** Timestamps, aging day-counts, and filenames
  ride the data clock (the latest snapshot), never the export moment.
  Re-export unchanged data, get identical bytes — diff two exports to prove
  nothing moved.
- **Undo is exact.** "Mark as collected" captures each tab's previous
  collection point and restores it in one transaction. The old single-run undo
  could leave mixed-baseline tabs collected and hide un-entered work.
- **Nothing silently mis-dates or vanishes.** "Feb 30 2026" is unreadable, not
  March 2nd (it used to mis-age receivables by days). 1–2 digit invoice
  numbers land in the billed ledger. Keyed ledger entries that match no known
  bucket are surfaced with row and column instead of dropped.
- **Hostile-input safe.** Infinity footage, 130k-row crashes, NUL-byte key
  collisions, CRLF-corrupted CSV re-imports, formula injection, reordered
  Google responses — all closed.

## Also in this release

- One "placed" definition everywhere (ledger, weekly buckets, gap report all
  use the same chain rule).
- Billing packets stamped with their run id for audit tracing.
- Compilation strays surfaced as a check finding.
- The digest computes from the same deduped view as billing — the email can
  no longer overstate footage on copy-tab sheets.

**Requires Node.js 22+.** Full changelog: `CHANGELOG.md`.
