# Changelog

## 0.3.1 — 2026-08-30
Trust hardening (fleet audit pass 6). Acks: every rowKey now identifies exactly
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
text (17-digit ticket numbers can no longer compare equal). Introduction walks
past their window treat undated rows as ack-resolvable (no false re-flags on
hourly sheets). Migration CLI no longer crashes on legacy DBs (and self-heals a
bricked empty migrations table); pre-migrate backups fire on any pending
migration and are no longer evicted first by retention. Diff lines view has
column headers and sizes columns from visible rows only. Billing packet holes
carry their tab name.

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
