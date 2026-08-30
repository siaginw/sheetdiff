# Changelog

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
After `git pull`, run `npm install && npm run db:push` (applies schema
changes to your existing SQLite db), then rebuild (`npm run build` or
`docker compose up -d --build`).
