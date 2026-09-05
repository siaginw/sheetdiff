# Architecture

How SheetDiff works inside. For setup and usage see the README; for the dev workflow see CONTRIBUTING.md.

```
Google Sheets ──readonly──▶ capture ──▶ gzip'd snapshots (SQLite)
                               │            │
                               │            ├─ snapshot_stats (capture-time deltas)
                               │            ▼
                               └────▶ diff engine ──▶ pending changes ──▶ dashboard badge
                                         │                                  │
                                         ├─ checks / gaps / production      ├─ CSV worklist
                                         └─ trace / GIS import              └─ billing packet CSV
```

## Boot sequence

`src/instrumentation.ts` runs once per server start (dev, `npm start`, Docker):

1. `ensureMigrated()` (`src/lib/db/migrate.ts`) applies committed migrations from
   `drizzle/`. Legacy databases created by `drizzle-kit push` (v0.2) have no
   `__drizzle_migrations` table — they are stamped as already-applied first, so
   nothing is re-created under existing data. A pre-migration backup is written to
   `data/backups/`. **Fail-closed**: a drifted schema aborts boot rather than
   serving requests with a broken database.
2. `startScheduler()` (`src/lib/scheduler.ts`) — see Scheduling below.

`GET /api/health` (`src/app/api/health/route.ts`) probes a real table (not just
`SELECT 1`), reports Google/SMTP/demo config state, and counts `staleCaptures` —
scheduled sheets whose latest snapshot exceeds the shared staleness window
(`src/lib/staleness.ts`). A non-zero count does NOT fail the probe (the service
is up); the operator reads it. Used by the Docker `HEALTHCHECK` and uptime monitors.

## Data model (`src/lib/db/schema.ts`)

| Table            | Purpose                                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`          | Google identity, encrypted OAuth tokens, digest settings                                                                                       |
| `spreadsheets`   | Tracked sheet + schedule (`scheduleKind/Hours/Time/Day`, `nextRunAt`)                                                                          |
| `tabs`           | Tracked Google tabs, optional explicit `keyColumn`                                                                                             |
| `snapshots`      | One gzip'd JSON blob per tab per run; `runId` groups a capture, `trigger` ∈ manual/scheduled/import, `isBaseline` marks the collected baseline |
| `snapshot_stats` | Capture-time delta (added/removed/changed) vs the previous non-import snapshot; cascade-deletes with its snapshot                              |
| `notes`          | Audit notes — scoped to run, tab, or row (`rowKey`); author-scoped delete                                                                      |
| `change_acks`    | "Entered downstream" marks per (tab, rowKey)                                                                                                   |
| `members`        | Viewer emails per owner (lowercase; expression-unique index)                                                                                   |

Snapshots are stored as gzip'd `{headers, rows}` JSON in SQLite (WAL mode).
Migrations live in `drizzle/` and are the only way schema changes ship.

## Capture pipeline (`src/lib/snapshots.ts`)

- **Single-flighted** per spreadsheet: a manual click racing the scheduler
  reuses the same in-flight promise — never a double capture.
- Reads via Google `values:batchGet` — API reads ignore filters/filter-views,
  which is what makes snapshots filter-proof. Chunked (~10 ranges per call,
  60-second timeout per chunk).
- `toSnapshotData` normalizes values, drops fully-empty rows, pads rows to grid
  width, and treats row 0 as headers.
- Each capture diffs against the previous **non-import** snapshot per tab (one
  `groupBy-max` query — `latestNonImportSnapshots` — never the whole history)
  and materializes the delta into `snapshot_stats` at write time.
- The whole run (snapshot inserts + schedule-state update) commits in one
  transaction. Stats are written _after_, best-effort: a failed stats insert is
  logged and skipped — never allowed to roll back real snapshots.
- **Auto-baseline**: the first-ever snapshot of a tab lands with
  `isBaseline: true`, so the dashboard "changes since collection" badge works
  from day one.

## Diff engine (`src/lib/diff/engine.ts` — pure, no I/O)

Row identity is resolved in a ladder, never by position:

1. Explicit `tabs.keyColumn` if configured.
2. Auto-detected single key: non-blank for ≥90% of rows, unique, station
   columns banned (a unique End-STA column must not key the diff).
3. Composite key: Activity + Start STA + End STA ("the 14800–15743 plow")
   when ~unique.
4. No identity at all.

**Blank-key fallthrough**: rows whose resolved key is blank — real trackers
pad tabs with hundreds of label-only rows whose composite key is empty — fall
through to content-hash matching over shared columns, then positional pairing
of blank leftovers. This is the old no-key path applied selectively, so padded
tails match their identical twins instead of flooding every consumer (stats,
billing, quiet-day) with remove+add noise.

Columns are matched by normalized header text; equal-count leftovers pair
positionally so a header rename is one change, not remove+add. Values compare
trimmed and numerically (`40` = `40.00` = `$40`). A row matched across
snapshots at a different index is `moved`, not `changed`.

`rowKey` (key value, else content hash of the row) is the stable identity that
acks and notes hang off — one definition shared by everything downstream.

## Baseline → pending changes (`src/lib/pending.ts`, `sync.ts`)

"Mark as collected" (`setBaseline`) makes a run the per-sheet-unique baseline;
imports can never be it. The pending set — baseline → latest sheet snapshot,
minus acknowledged changes — is computed once and shared by the dashboard, the
CSV worklist export, and the digest, so the three can never disagree.

- **Quiet-day short-circuit**: sums `snapshot_stats` over `(baseline, latest]`.
  When every snapshot in the window has a stats row and all deltas are 0/0/0
  (the common hourly case), it returns "nothing pending" without loading a
  single blob. A **coverage guard** requires _every_ snapshot in the window to
  have a stats row — retention cascades, failed inserts, and legacy rows all
  create holes, and a hole means "unknown", never "no changes": it falls
  through to the full diff.
- Acks resolve against the snapshot that _introduced_ a change (bounded
  newest-first walk, ≤120 snapshots), so an ack survives unrelated later
  snapshots and re-flags the moment the row changes again.

## Derived analytics (all pure logic over snapshots)

- **Checks** (`checks.ts`) — the gap linter: station-continuity breaks,
  duplicate shot identities, cross-tab strays. Plain feet and survey notation.
- **Gap report** (`gaps.ts`) — reconstructs the bore/plow/trench/gap chain and
  reconciles `placed + known gaps − overlaps = designed span`.
- **Production** (`production.ts`) — date hygiene (rollover is never silent),
  backdated late-entry detection, TOTALS-tab reconciliation plus an
  over-placement guard (TOTALS rows where Placed exceeds Designed), per-crew/day
  board (hand-spellings of one crew collapse to an alphanumeric key, displayed
  as the most-typed spelling), aging ledger of unaccounted holes.
- **Trace** (`trace.ts`) — one row's history across snapshots by station
  number, free text, or key.
- **GIS import** (`import.ts`) — CSV/XLSX diffed against the latest snapshot;
  the zip guard is three-layered: declared-size sum, per-entry trial-inflation
  of EVERY central-directory entry (descriptors included) against a shared
  budget, and EOCD entry-count-lie rejection).
- **Cross-tab dedup** (`dedupe.ts`) — the ONE algorithm every sheet-wide
  rollup uses, on ANY sheet. Row identity runs a smart hierarchy: the tab's
  chosen key column (validated populated+unique, else ignored), activity +
  PARSED stations (a compilation tab's "2+14" matches the working tab's
  "214"), an auto-detected ID column (SKU/ticket/email vocabulary), then
  whole-row content — with the content key registered alongside every tier
  so verbatim copies match however each side keyed. The tier is decided once
  on latest data and applied to every slice. Ownership is decided once on latest data
  (richest tab first — column count desc, then position; compilation tabs
  re-list with FEWER columns, so raw position let a leading Line List own
  everything and flip the billing basis — and the same ownership is applied
  to baseline and window snapshots via `ownedRows()`, so a compilation tab
  can never swing placed-since negative. Known trade-off: a hypothetical
  compilation that ADDS columns and FOLLOWS its sources can steal ownership
  the other way; real compilation tabs drop columns, and same-width sheets
  fall through to position). A tab whose keyed rows are ≥95% owned by
  earlier tabs (≥20 rows) is a pure copy — skipped by every rollup and every
  to-enter count, with its strays surfaced as a check finding. Output is
  position-preserving: dropped rows become blanks, "Row N" stays the sheet's
  true row number.
- **Billing packet** (`billing.ts` + page + route) — placed footage since
  collection, open holes flagged _do not invoice_, over-placement, office-entry
  backlog, invoice-ledger BILLABLE rows + missed-run chases, the to-enter
  worklist, and late entries in one CSV stamped with snapshot provenance (time
  - run id). Everything reads the DATA clock (the latest snapshot), so the
    page and the CSV can never disagree and re-exports are byte-identical.
    Formula-injection-guarded, aggregated across every tracked tab, deduped.

## Scheduling, digest, maintenance (`scheduler.ts`, `digest.ts`, `maintenance.ts`)

One in-process tick per minute (`.unref()`'d, single-flight, re-entrancy
guarded): due captures (failures push `nextRunAt` forward so a broken sheet
can't loop every minute), due digest emails (every completed evaluation — sent
or skipped — bumps the cooldown), and daily maintenance after 3am local:
snapshot retention (newest N=200 non-baseline per tab, baselines always kept,
floor of 2) plus verified SQLite backups to `data/backups/` (keep 14). If
`HEALTHCHECK_PING_URL` is set, it is pinged only when a tick completed at least one successful capture — a dead OAuth token fails every capture while ticks still succeed, so the ping goes silent and the monitor notices.

## HTTP surface & access control

Routes: `/` dashboard, `/sheets/new`, `/sheets/[id]` (diff + panels),
`/sheets/[id]/report` (weekly report), `/sheets/[id]/billing` (billing-day
dashboard), `/settings` (notifications hub), `/sheets/[id]/export`
(worklist CSV), `/export/queue` (entry-queue CSV),
`/export/billing` (billing packet CSV) and `/export/billing/pdf` (same
packet as PDF — one shared assembly),
`/auth/{login,callback,demo}`, `/api/health`.

`src/lib/access.ts`: owners control their sheets; `members` (matched by
lowercased Google email) get viewer access to everything the owner shares —
read diffs/notes, write audit notes, tick acks, mark collections. All
owner-only mutations gate through `requireOwnedSpreadsheet`; viewer-writable
actions gate through `requireSharedSpreadsheet`. Export routes accept either
role via `getSheetAccess`.

## Security posture

- Google OAuth with `spreadsheets.readonly` only — the app cannot write sheets.
- `crypto.ts`: two scrypt-derived subkeys from `APP_SECRET` (one for AES-256-GCM
  token encryption, one for session-cookie signing — never shared bytes);
  signed sessions expire (30 days).
- `/auth/demo` requires `ENABLE_DEMO=1` and only sees seeded demo data.
- CSV exports are formula-injection-guarded (`csv.ts`); imports are
  size-capped before decompression.

## Module map

| Path                                                                       | Role                                                                                    |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/instrumentation.ts`                                                   | Boot: fail-closed migrations, scheduler start                                           |
| `src/lib/db/{index,schema,migrate}.ts`                                     | SQLite (WAL), schema, boot migrations                                                   |
| `src/lib/diff/{engine,normalize,worddiff,widths}.ts`                       | Pure diff engine + normalization + layout math                                          |
| `src/lib/snapshots.ts`, `snapshot-cache.ts`                                | Capture, gzip storage, schedule math, stats materialization, decode LRU                 |
| `src/lib/pending.ts`                                                       | Baseline→pending resolver with quiet-day short-circuit                                  |
| `src/lib/sync.ts`                                                          | Ack resolution + introduction walk                                                      |
| `src/lib/checks.ts`, `gaps.ts`, `production.ts`, `trace.ts`                | Pure analytics                                                                          |
| `src/lib/dedupe.ts`                                                        | Identity-keyed cross-tab dedup + ownership filter                                       |
| `src/lib/billing.ts`                                                       | Billing packet builder + CSV                                                            |
| `src/lib/import.ts`                                                        | GIS CSV/XLSX import (bomb-guarded)                                                      |
| `src/lib/actions.ts`, `access.ts`                                          | Server actions, owner/viewer gates                                                      |
| `src/lib/google.ts`, `session.ts`, `crypto.ts`                             | OAuth+reads, sessions, keys/AEAD                                                        |
| `src/lib/scheduler.ts`, `digest.ts`, `digest-actions.ts`, `maintenance.ts` | Tick loop, email + test-send action, retention/backup                                   |
| `src/lib/detect.ts`, `csv.ts`, `format.ts`, `staleness.ts`, `utils.ts`     | Station/column detection, helpers, shared capture-staleness rule                        |
| `src/lib/permits.ts`                                                       | Permit-status join (header-gated, silent no-op); stoppage weeks live in `production.ts` |
| `src/lib/emails/digest.tsx`                                                | Digest email template (react-email)                                                     |
| `src/app/…`                                                                | Pages, export/auth/health routes                                                        |
| `src/components/diff/diff-view.tsx`, `src/components/sheet/*`              | Diff UI, sheet panels                                                                   |
| `scripts/{generate-env,migrate,seed-demo}.mjs`                             | `npm run setup` / `db:migrate` / `seed-demo`                                            |
