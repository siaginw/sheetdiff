# Changelog

## 0.3.1 — 2026-08-30

**Requires Node.js 22+** (better-sqlite3 v13 is N-API-based and unsupported on
end-of-life Node 20 — it segfaults on Linux). CI now runs Node 22 and is
green for the first time; `npm ci` enforces the floor (engine-strict).

Trust hardening (fleet audit passes 6 + 7). Acks: every rowKey now identifies exactly
one row — repeated shot labels ("S3 twice"), identical added rows, and identical
removed rows each get distinct keys, so one acknowledgment can never silently
drop a second change from the to-enter worklist. Staleness is now visible
everywhere "up to date" appears: digest email (subject, banner, per-sheet line),
dashboard badge, and `/api/health` (`staleCaptures`) share one rule, and paused
sheets say "paused". "Mark as collected" counts sheet-wide and ack-aware (same
resolver as the CSV) and asks for confirmation when unentered work exists.
Key-column detection no longer promotes arbitrary unique columns (label edits
stay single changes, not remove+add), scans the full sheet width, and recognizes
"Shot #"/"Emp #"/Name headers. Numbers above 15 significant digits compare as
text (17-digit ticket numbers can no longer compare equal). Migration CLI no
longer crashes on legacy DBs (and self-heals a bricked empty migrations
table); pre-migrate backups fire on any pending migration (hash-aware, on the
CLI too) and are no longer evicted first by retention. Diff lines view has
column headers (font-aligned with cells) and sizes columns from visible rows
only. Billing packet holes carry their tab name. Pass 7: introduction walks
are anchored by the collection baseline, so a re-changed row can never be
silently swallowed by an old ack (and old acks stop re-nagging) — the walk
covers the exact window, not a 30-snapshot guess; the billing CSV quotes
comma/CR fields (the formula guard alone splits on commas — second
regression of the same line, now test-pinned); rowKey suffixes dodge raw keys
that contain "#"; degenerate setBaseline inputs are a no-op instead of a
baseline wipe; digest emails are shape-validated; backup retention evicts
oldest-first by real timestamp and cleans -shm/-wal litter; key detection
tokenizes multi-word headers ("EMP NO", "PO Number"); the fresh-import
timeline explains itself; digest subjects lead with staleness when data is
stale; the README quick start no longer crashes on fresh clones (`npm run
setup`); oversized check lists collapse to honest summaries (the real
43-tab tracker made ~950 overlap findings AND 1,325 cross-tab strays from
its compilation tab — both collapse now, panel 1342 → double digits); the
sheet page no longer pans sideways on phones; suite grew to 218 tests.

Pass 8: the account menu no longer crashes every page when opened (a bare
Base UI GroupLabel took the page down — sign-out/share/digest settings were
unreachable); "Stop tracking…" opens its dialog again; the lockfile is back
in sync (CI had never been green — 29/29 failures — and Docker builds
failed at npm ci; esbuild now pinned at root); a deletion that follows a
change is no longer swallowed by the change’s ack (removed rows date by ROW
existence: key for keyed rows, identical-family count for padding rows —
which also ends the removed-padding whack-a-mole); “Mark as collected” is
now ONE atomic statement scoped to the tabs the run covers (no mid-flight
zero-baseline window, no cross-tab wipe, no racing double baselines); the
APP_SECRET placeholder from .env.example is rejected at key derivation; the
xlsx zip guard trial-inflates data-descriptor entries via the central
directory (a 522 KB crafted file previously materialized 512 MB in heap);
wide diffs scroll horizontally in lines mode; the demo login refuses real
databases; digest day/time inputs are strictly validated.

Pass 9: the account-menu dialogs (digest settings, share access, stop
tracking) were unreachable — they unmounted with the closing menu ~200ms
after opening, and never opened at all on production builds; they are now
state-driven and mounted OUTSIDE the menu. The xlsx zip guard rejects an
EOCD entry-count lie (JSZip ignores the count and walks hidden bomb entries
that the count-based guards skipped) and reports corrupt archives instead of
leaking zlib internals. Blank-key additions and changes are dated by family
count growth — a family that shrank and regrew no longer lets a stale ack
swallow the regrown row. keySets bail to content matching when a walked
snapshot's headers drift at the identity columns. The APP_SECRET placeholder
list covers every public .env.example value (whitespace-trimmed). The migrate
CLI applies positionally like the boot path (a hash-divergent journal is a
warn + no-op, not a crash). engine-strict enforces the Node floor at install;
CI pins TZ for the local-calendar stamp test; check messages pin en-US
grouping; notes can be deleted (and the Delete button actually deletes — it previously
re-saved unless the textarea was emptied first); backwards-row findings
collapse; collapsed cross-tab findings only reference their own tab's rows;
suite grew to 244.

Fleet 11: queue-export headers are formula-guarded like values; a quiet sheet
no longer reports a missing collection point (quiet-day null was conflated with
no-baseline); the queue sorts oldest-first even before the first ack (the walk
now runs whenever there are unresolved rows); the office-pipeline backlog
reaches the production panel body AND the billing CSV (both were half-wired);
printing works from dark mode (light tokens under @media print); the dead-man
ping cannot hang the scheduler (10s timeout) and its decision is extracted and
test-pinned; dialogs reset state through portal-unmounted body children (the
controlled-onOpenChange approach never fired for programmatic opens);
TabSettings is keyed per tab (cross-tab settings corruption); export stamps name
the true latest snapshot; report aggregation extracted and pinned; CI runs
Node 22+24; Dependabot configured; suite 262.

Fleet-11.5 (the invoice plan ships): INVOICE-LEDGER rollup — reads the
sheet's own "Entered in InEight" + "Invoice #" columns and classifies every
completed shot: billable-now (in GIS, never entered — aged by completion date,
with total ft, median and oldest age), billed-by-invoice-number, queued-for-a
named-run, and missed-run (a month marker whose run already happened); shown
in the production panel and as billing-packet rows. CROSS-TAB ROLLUP DEDUP —
compilation tabs (Line List copies the working tabs) no longer double-count
the weekly report: tabs whose rows are all duplicates of already-aggregated
tabs are skipped. SECURITY.md, bug-issue template, Discussions pointer;
suite 266.

Pass 10 (deep dive): crews canonicalize (the real tracker's 36 hand-spellings
of ~10 crews defragmented, most-typed spelling shown); over-placement guard
(TOTALS Placed vs Designed per package — do-not-invoice rows; the real file
has five packages over-placed, one by 953 ft); bulk "mark all entered"; grid
diff mode gains the per-row ack/note actions; multi-member identical-content
families date individually by rank (an ack can no longer swallow the second
of two rows that converged one window apart); keySets bail on ANY header
drift (duplicate-header inserts read the wrong column); digest-save toast and
dialog state resets; shared DB-test harness; note-delete and
backwards-collapse pinned; README OAuth guidance fixed — publish to
production-unverified, because Testing-mode refresh tokens EXPIRE AFTER 7
DAYS and an always-on snapshotter silently dies a week in.

## 0.3.0 — 2026-08-30
Production analytics: date hygiene, late-entry detection, TOTALS reconciliation,
crew productivity board, aging gap ledger. Capture-time stats materialization.
Database migrations (auto-applied on startup; legacy DBs stamped non-destructively).
Sharing: viewer accounts by email. GIS import diff. Digest email (daily/weekly).
Auto gap report (bore/plow/gap chain). Retention + nightly verified backups.
Docker image with health check and dead-man-switch heartbeat.

### Upgrading
After `git pull`, run `docker compose up -d --build` (Docker) or
`npm ci && npm run build && npm restart` (bare). Migrations apply automatically
on startup — existing databases are stamped and preserved.

## 0.2.0 — 2026-08-29
First public version. Snapshots, GitHub-style diffs, checks (gap linter),
audit workflow (notes, acknowledgments, CSV worklist), footage ledger.

### Upgrading
*(Superseded in 0.3.0: migrations apply automatically on startup — just `git pull` and restart.)*
