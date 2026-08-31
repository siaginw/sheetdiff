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

| Table | Purpose |
|---|---|
| `users` | Google identity, encrypted OAuth tokens, digest settings |
| `spreadsheets` | Tracked sheet + schedule (`scheduleKind/Hours/Time/Day`, `nextRunAt`) |
| `tabs` | Tracked Google tabs, optional explicit `keyColumn` |
| `snapshots` | One gzip'd JSON blob per tab per run; `runId` groups a capture, `trigger` ∈ manual/scheduled/import, `isBaseline` marks the collected baseline |
| `snapshot_stats` | Capture-time delta (added/removed/changed) vs the previous non-import snapshot; cascade-deletes with its snapshot |
| `notes` | Audit notes — scoped to run, tab, or row (`rowKey`); author-scoped delete |
| `change_acks` | "Entered downstream" marks per (tab, rowKey) |
| `members` | Viewer emails per owner (lowercase; expression-unique index) |

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
  transaction. Stats are written *after*, best-effort: a failed stats insert is
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
  single blob. A **coverage guard** requires *every* snapshot in the window to
  have a stats row — retention cascades, failed inserts, and legacy rows all
  create holes, and a hole means "unknown", never "no changes": it falls
  through to the full diff.
- Acks resolve against the snapshot that *introduced* a change (bounded
  newest-first walk, ≤30 snapshots), so an ack survives unrelated later
  snapshots and re-flags the moment the row changes again.

## Derived analytics (all pure logic over snapshots)

- **Checks** (`checks.ts`) — the gap linter: station-continuity breaks,
  duplicate shot identities, cross-tab strays. Plain feet and survey notation.
- **Gap report** (`gaps.ts`) — reconstructs the bore/plow/trench/gap chain and
  reconciles `placed + known gaps − overlaps = designed span`.
- **Production** (`production.ts`) — date hygiene (rollover is never silent),
  backdated late-entry detection, TOTALS-tab reconciliation, per-crew/day
  board, aging ledger of unaccounted holes.
- **Trace** (`trace.ts`) — one row's history across snapshots by station
  number, free text, or key.
- **GIS import** (`import.ts`) — CSV/XLSX diffed against the latest snapshot;
  zip central-directory sizes are summed *before* decompression (bomb guard;
  data-descriptor entries from streamed exports are skipped).
- **Billing packet** (`billing.ts` + route) — placed footage since collection,
  open holes flagged *do not invoice*, the to-enter worklist, late entries —
  one CSV stamped with snapshot provenance, formula-injection-guarded, aggregated
  across every tracked tab.

## Scheduling, digest, maintenance (`scheduler.ts`, `digest.ts`, `maintenance.ts`)

One in-process tick per minute (`.unref()`'d, single-flight, re-entrancy
guarded): due captures (failures push `nextRunAt` forward so a broken sheet
can't loop every minute), due digest emails (every completed evaluation — sent
or skipped — bumps the cooldown), and daily maintenance after 3am local:
snapshot retention (newest N=200 non-baseline per tab, baselines always kept,
floor of 2) plus verified SQLite backups to `data/backups/` (keep 14). If
`HEALTHCHECK_PING_URL` is set, each successful tick pings it — a dead-man
switch that alerts when snapshots silently stop.

## HTTP surface & access control

Routes: `/` dashboard, `/sheets/new`, `/sheets/[id]`, `/sheets/[id]/export`
(worklist CSV), `/sheets/[id]/export/billing` (billing packet CSV),
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

| Path | Role |
|---|---|
| `src/instrumentation.ts` | Boot: fail-closed migrations, scheduler start |
| `src/lib/db/{index,schema,migrate}.ts` | SQLite (WAL), schema, boot migrations |
| `src/lib/diff/{engine,normalize,worddiff}.ts` | Pure diff engine + normalization |
| `src/lib/snapshots.ts` | Capture, gzip storage, schedule math, stats materialization |
| `src/lib/pending.ts` | Baseline→pending resolver with quiet-day short-circuit |
| `src/lib/sync.ts` | Ack resolution + introduction walk |
| `src/lib/checks.ts`, `gaps.ts`, `production.ts`, `trace.ts` | Pure analytics |
| `src/lib/billing.ts` | Billing packet builder + CSV |
| `src/lib/import.ts` | GIS CSV/XLSX import (bomb-guarded) |
| `src/lib/actions.ts`, `access.ts` | Server actions, owner/viewer gates |
| `src/lib/google.ts`, `session.ts`, `crypto.ts` | OAuth+reads, sessions, keys/AEAD |
| `src/lib/scheduler.ts`, `digest.ts`, `maintenance.ts` | Tick loop, email, retention/backup |
| `src/lib/detect.ts`, `csv.ts`, `format.ts`, `staleness.ts`, `utils.ts` | Station/column detection, helpers, shared capture-staleness rule |
| `src/lib/emails/digest.tsx` | Digest email template (react-email) |
| `src/app/…` | Pages, export/auth/health routes |
| `src/components/diff/diff-view.tsx`, `src/components/sheet/*` | Diff UI, sheet panels |
| `scripts/{generate-env,migrate,seed-demo}.mjs` | `npm run setup` / `db:migrate` / `seed-demo` |
