# Changelog

## 0.3.1 — 2026-08-30
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
43-tab tracker made ~950 overlap findings, drowning the checks panel and
digest); the sheet page no longer pans sideways on phones; suite grew to
207 tests.

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
