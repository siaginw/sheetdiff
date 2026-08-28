# SheetDiff (working name) — a GitHub-style version tracker for Google Sheets

## The decision: build the tracker, NOT a Google Sheets clone

The team's problem isn't the spreadsheet — it's that changes are invisible after the manager pulls the data. A new sheets app only fixes that if everyone migrates (they won't). The tracker works with the sheets you already have, zero migration, and delivers the actual value: visible, diffable change history. That's the GitHub analogy done right — GitHub didn't replace git; it added the visibility layer on top of it.

## Stack (researched)

- **Next.js + TypeScript** — largest ecosystem, one codebase for UI + backend, one-command local run, deploy later with one click
- **Tailwind CSS + shadcn/ui** — the polished GitHub-grade look
- **TanStack Virtual** — smooth scrolling of large diff tables
- **SQLite + Drizzle ORM** — zero-setup file DB, clean path to Postgres later
- **googleapis** — official SDK for OAuth + Sheets API
- **Vitest** — real test suite for the diff engine

## Version 1 features

1. Connect Google account (OAuth, read-only Sheets scope)
2. Add spreadsheet by pasting URL; pick tabs to track
3. Snapshots: manual "Snapshot now" + per-sheet schedule (hourly / daily at HH:MM / weekly / off)
4. GitHub-commits-style snapshot timeline per sheet
5. **Showpiece diff view** between any two snapshots (default: last-collected baseline → latest): added rows green, removed red, moved subtle, changed cells `old → new`, summary chips, changes-only toggle, search, sticky headers
6. "Mark as collected" baseline — "what changed since the manager last pulled?" in one click

## Hard parts solved by design

- **Filter-proof:** Google's API returns every row/column regardless of filters — filters are visual-only, snapshots can't be corrupted by them
- **Sort-proof:** rows matched by key column (auto-detected, editable per tab), content-hash fallback; reorders show as "moved," never as false changes
- **No noise:** numeric-aware comparison (`40` = `40.00`), trimmed strings, blank = empty
- **Minimal permissions:** `spreadsheets.readonly` + profile; paste-URL avoids Drive access entirely
- Snapshots stored as JSON blobs per tab in SQLite; diffs computed on the fly

## Build order

1. Scaffold Next.js + Drizzle + shadcn/ui, git init
2. Google OAuth → paste-URL → tab discovery → first snapshot stored
3. Diff engine + Vitest suite
4. Diff UI showpiece + timeline + baseline
5. Scheduler + dashboard polish
6. README with Google Cloud OAuth walkthrough (~10 min one-time setup)

## Out of scope v1

Email digests, Excel, InEight export, multi-user deployment, editing data, formatting diffs — all clean later additions.