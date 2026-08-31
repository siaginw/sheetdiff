# Privacy policy template (for deployers)

SheetDiff is self-hosted: **you** are the data controller, and this file is a
starting point for the policy your organization publishes. Edit the brackets.

## What this instance stores

- **Google account identity** (name, email, avatar) for every person who signs in.
- **OAuth refresh tokens**, encrypted at rest with a key derived from `APP_SECRET`.
- **Snapshots of the Google Sheets you add** — full copies of tracked tabs,
  gzip-compressed in the local SQLite database — plus derived analytics
  (diffs, checks, footage math) and audit notes/acknowledgments your users write.
- **Digest emails** sent via your SMTP server to addresses your users configure.

## Where it lives

Everything above stays in [`data/`](./data) on the machine running SheetDiff
([`DATABASE_PATH`](.env.example)). Snapshots are not encrypted at rest; protect
the database file and its backups the way you protect the spreadsheets
themselves. Backups land in `data/backups/` (retention: `SHEETDIFF_BACKUPS`).

## What it never does

- Reads only via the `spreadsheets.readonly` scope — it cannot edit sheets.
- Sends sheet contents nowhere except the digest emails your users configure.
- Snapshots are taken only of spreadsheets explicitly added by a signed-in user.

## Deletion

Deleting a sheet's snapshots ("Stop tracking") removes them from the database.
The SQLite file itself (and its backups) is the system of record — remove
`data/` to delete everything.

_Generated from the SheetDiff template — customize before publishing._
