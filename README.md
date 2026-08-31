# SheetDiff — version tracking for Google Sheets

SheetDiff snapshots your team's Google Sheets and shows **GitHub-style diffs** between any two
snapshots — added rows, removed rows, changed cells as `old → new` — so the people who *collect*
your data always know what changed since they last pulled it.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

![The diff view](docs/img/diff-light.png)

**In one line:** automatic snapshots, human-readable diffs, and an audit trail of who changed what — with a gap linter that catches missing footage and overlapping stations in utility-construction production logs before invoicing or GIS upload. Self-hosted and open source: keep your spreadsheets, keep your data, gain the accountability enterprise trackers charge $40–150 per user per month for.

**The workflow it fixes:** a team enters data into shared sheets, a manager pulls that data daily
into another system (an ERP, GIS, anywhere). Someone fixes a number *after* the pull — the
manager never finds out, the downstream system goes stale. SheetDiff makes that change impossible
to miss: **"Mark as collected"** sets a baseline, and every change since shows up as a red badge
on the dashboard.

## Screenshots

| | |
|---|---|
| ![Landing](docs/img/landing.png) | ![Dashboard](docs/img/dashboard.png) |
| ![Diff in dark mode](docs/img/diff-dark.png) | ![Audit workflow](docs/img/audit-dark.png) |

## Highlights

- **Read-only by design.** SheetDiff connects with a Google scope that can read sheets but never
  modify them.
- **Filter-proof.** Snapshots are read through Google's API, which returns every row and column
  regardless of filters or filter views. Someone leaving a filter on cannot corrupt a snapshot.
- **Sort-proof.** Rows are matched between snapshots by a key column (auto-detected, or pick your
  own per tab). Sorting a sheet produces "moved" markers, never false changes.
- **No noise.** `40` vs `40.00` vs `$40` are the same number. Trailing blanks don't diff. Long
  text values get word-level diffs.
- **Gap report.** Reconstructs each tab's footage chain (bore/plow/trench/gap rows only) and reconciles the math: placed + known gaps − overlaps vs. designed span.
- **Shot history.** Trace a single row through every snapshot by station number, free text, or key.
- **Checks (the gap linter).** Station-continuity breaks (`2 ft gap: row 3 ends at 15741 but
  row 4 starts at 15743`), duplicate shots, and the same key stranded in two tabs — caught on
  every snapshot. Understands plain feet and survey notation (`4+47`).
- **Audit workflow.** Attach notes explaining *why* things changed; tick changes off as
  *entered downstream*; download the unresolved changes as a CSV worklist; diff a GIS export
  (CSV/XLSX) against the sheet; get a daily digest email with everything still waiting to be
  collected.
- **Footage ledger.** Per-tab footage totals from your station columns, with the change since
  last collection — when a correction quietly moves your totals, you see the number move.
- **Scheduled or manual snapshots.** Hourly / daily at a time / weekly, or "Snapshot now".
- **GitHub-style UI.** Red/green `−/+` lines, changed-value annotations, diffstat blocks, a
  git-log timeline, code/table layouts, dark mode.

## Quick start

Requires Node.js 22+. Runs entirely on your machine — the data never leaves your SQLite file
and Google account.

```bash
git clone https://github.com/siaginw/sheetdiff.git && cd sheetdiff
npm install
npm run setup              # .env with a random APP_SECRET + data/ + the database
npm run dev                # http://localhost:3000 (add Google credentials to .env when ready)
```

Prefer filling in `.env` by hand? `cp .env.example .env`, then run `mkdir data && npm run db:migrate` —
`drizzle-kit push` alone crashes on a fresh clone (it does not create the `.db` directory).

### Try the demo (no Google needed)

```bash
npm run seed-demo
# set ENABLE_DEMO=1 in .env, restart the dev server,
# then open http://localhost:3000/auth/demo
```

This seeds a fake "US2 Daily Production" sheet whose snapshots tell a real audit story — a
wrong ending station (15741 → 15743, the 2 ft gap), a shot entered twice as plow *and* bore,
a survey-notation correction (164+80 → 164+82), and a shot stranded in two tabs for the
cross-tab check to catch. It also seeds a demo *viewer* — sign in at `/auth/demo?as=viewer`
to see exactly what a shared teammate (your data collector) sees. `ENABLE_DEMO` is opt-in and
should stay off on any real deployment.

## Privacy

Self-hosted means YOU hold the data — snapshots, tokens, notes, everything lives in
your `data/` directory. Ship a policy for your users from the template in
[PRIVACY.md](PRIVACY.md).

## Self-hosting (always-on)

Scheduled snapshots and the digest email run **while the app runs**. For anything shared,
run it somewhere that's always on.

**Docker (recommended):**

```bash
cp .env.example .env   # fill in
docker compose up -d --build
```

The database persists in `./data`. Behind a proxy with a domain? Set `APP_URL` and
`GOOGLE_REDIRECT_URI` in `.env` to match.

**Any always-on box:** a spare office PC, a home server, or a ~$5 VPS with Node 22+ works —
`npm ci && npm run build && npm start` (consider [pm2](https://pm2.io) or a systemd service to
keep it alive).

## Security notes

- Google OAuth only, with the **read-only** `spreadsheets.readonly` scope — SheetDiff cannot
  modify your sheets.
- Refresh tokens are encrypted at rest (AES-256-GCM, key derived from `APP_SECRET`).
- Single-workspace by design: every user signs in with Google; only sheets you add are tracked.
- `/auth/demo` requires `ENABLE_DEMO=1` and only knows about deliberately seeded demo data.
- Keep `.env` and `data/` out of backups you don't trust — snapshots contain your sheet data.

## Google setup (one-time, ~10 minutes)

SheetDiff needs its own OAuth client so it can read sheets with *your* account.

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and create a project
   (any name, e.g. "SheetDiff").
2. **APIs & Services → Library** → search for **Google Sheets API** → **Enable**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External**, create.
   - App name: anything (e.g. "SheetDiff"), add your email where asked.
   - You can skip scopes/branding.
   - **Publish the app to production (leave it unverified).** Do NOT leave the
     consent screen in "Testing": refresh tokens from Testing apps **expire
     after 7 days**, and an always-on snapshotter silently stops working a week
     in. A sensitive-but-not-restricted scope like `spreadsheets.readonly` runs
     fine unverified — your users click through the "app not verified" warning
     once. (Google Workspace *internal* user type skips the warning entirely if
     all your users share your Workspace.) Each SheetDiff install uses its own
     project, so the 100-user cap never binds.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized redirect URIs: add exactly `http://localhost:3000/auth/callback`
   - Create, then copy the **Client ID** and **Client secret**.
5. Put them in your `.env`:

   ```
   GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=your-secret
   GOOGLE_REDIRECT_URI=http://localhost:3000/auth/callback
   ```

6. Restart `npm run dev`, open the app, and click **Connect Google Sheets**.

The tool requests these scopes: `spreadsheets.readonly` (read sheet data), plus basic profile
(name/email/picture). It never asks for — and cannot use — write access.

## Using SheetDiff

1. **Add sheet** — paste a Google Sheets URL. Pick which tabs to track and (optionally) which
   column identifies rows on each tab; auto-detection usually gets it right. The first snapshot
   is taken immediately.
2. **Snapshot** — manually with *Snapshot now*, or set a schedule per sheet (Schedule button).
   Scheduled snapshots run while the app is running.
3. **Diff** — the sheet page shows the diff between any two snapshots (defaults to
   *last collection → latest*), rendered like a code review: red `−` lines, green `+` lines,
   and a `~ column: old → new` annotation spelling out every changed value. Timeline on the
   left; click an entry to diff up to it.
4. **Mark as collected** — after pulling data into your downstream system, click
   *Mark as collected* on the snapshot you pulled from. The dashboard then shows
   *"N changes since collection"* for each sheet — that badge is the whole point.

## Audit workflow features

- **Audit notes** — attach the *why* to any snapshot (timeline 💬 button) or changed row
  (per-row note button): "ending station was entered wrong — GIS has 15743, 2 ft gap". Notes
  appear next to the diff, in the timeline, and in the daily digest, so nobody has to dig
  through chat history.
- **Per-change acknowledgment** — hover any changed/added/removed row and click ✓ to mark it
  *entered downstream* (InEight or wherever). The dashboard counts what's still to enter;
  if a row changes again after being acknowledged, it re-flags itself automatically.
- **Checks (the gap linter)** — every snapshot runs station-continuity, duplicate-shot, and
  cross-tab checks: `2 ft gap: row 3 ends at 15741 but row 4 starts at 15743`,
  `"S3" appears 2× — duplicate shot?`, `"S5" appears in PE4 and PE7`. Station formats
  understood: plain feet (`15743`) and survey notation (`4+47`, `164+82`).
- **GIS import** — *Compare GIS export* takes a `.csv` or `.xlsx` export from your GIS and
  diffs it against the latest sheet snapshot: shots missing on either side, station
  mismatches, type disagreements. Excel tabs are matched to tracked tabs by name; CSV maps
  to a tab you pick. Imports appear in the timeline as `⭳ GIS import` entries.
- **Entry queue export** — one CSV row per *shot* in the tab's own column order, oldest
  introduction first: the typing list for the office system, not a cell-change log. Removed
  rows ship as delete-downstream summaries.
- **Weekly production report** — `…/report`: footage per week (as dated by crews),
  week-over-week delta, printable one-pager.
- **Daily/weekly digest email** — account menu → *Digest email…*: pick daily or a weekday, and
  each send includes what changed since the last collection, unresolved changes, check findings,
  footage movement, and audit notes. Needs SMTP settings in `.env` (Gmail App Password works — see the commented block in `.env.example`).

For deliverability on your own domain, consider signing with DKIM — nodemailer
supports it via `dkim: { domainName, keySelector, privateKey }` transport options
(see nodemailer.com/dkim).
- **Production report.** Date hygiene, backdated late entries, TOTALS-tab reconciliation, a per-crew per-day footage board, and an aging ledger of unaccounted holes — generated from the snapshots you already take. The **invoice ledger** reads your sheet's own "Entered in InEight" + "Invoice #" columns: what's billable right now (aged, with footage), what's billed under which invoice number, and runs already missed.
- **Billing-day packet.** Placed footage since collection, open holes (do-not-invoice),
  over-placement warnings (TOTALS Placed beyond Designed), the office-entry backlog per the
  sheet's own "entered" column, the to-enter worklist, and late entries in one CSV.
- **Monitoring.** Set `HEALTHCHECK_PING_URL` (see `.env.example`) to a free healthchecks.io monitor and get alerted if snapshots ever silently stop.

**When the app seems quiet:** check `docker compose logs sheetdiff` for `[scheduler]` errors (most common: revoked Google token — re-authenticate via the app), verify `curl localhost:3000/api/health` shows `"ok":true` (a non-zero `staleCaptures` means scheduled snapshots are overdue — the pages still render from old data, so this is often the first visible sign), check disk space (`data/backups/` grows), and confirm the container is running (`docker ps`). To restore: stop the container, copy the newest `data/backups/sheetdiff-YYYY-MM-DD.db` over `data/sheetdiff.db` (delete the `-wal` and `-shm` siblings), restart.

- **Self-maintaining data** — automatic nightly backups (`data/backups/`, keep 14 by default)
  and snapshot retention (keep the newest 200 per tab, baselines always kept). Both tunable via
  `SHEETDIFF_KEEP_SNAPSHOTS` / `SHEETDIFF_BACKUPS` in `.env`.
- **Sharing** — account menu → *Share access…*: add teammates by email. When they sign in with
  that Google account they see your sheets, read diffs and audit notes, tick changes off as
  entered, and mark collections — the exact workflow of the person collecting your data —
  while all destructive controls (schedules, imports, deletes, settings) stay owner-only.

## Updating your deployment

New version shipped? That's all you do:

```bash
git pull
docker compose up -d --build
```

The container applies any database migrations automatically on startup. Your data lives in `./data` and is never touched beyond additive schema changes — the app also keeps nightly copies in `./data/backups/`.

Running without Docker? Same two steps minus Docker: `git pull && npm ci && npm run build && npm restart`.

First start on Linux: Docker creates `./data` as root if the folder is missing, which the in-container app user can't write to. Create it once: `mkdir -p data && sudo chown 1000:1000 data`.

## Development

```bash
npm test           # domain test suite (312 tests: engine, checks, gaps, trace, acks, imports, production, billing, DB gates)
npm run db:generate  # turn schema edits into a committed migration (applied on next start)
npm run build      # production build
```

Stack: Next.js (App Router) + TypeScript, Tailwind + shadcn/ui, SQLite via Drizzle ORM,
`googleapis` for OAuth + Sheets API, TanStack Virtual for large diff tables.

### Where things live

| Path | What |
|---|---|
| `src/lib/diff/engine.ts` | The diff engine — pure logic, fully unit-tested |
| `src/lib/diff/normalize.ts` | Value/key normalization (numeric equivalence etc.) |
| `src/lib/snapshots.ts` | Capture runs, gzip'd snapshot storage, schedule math |
| `src/lib/google.ts` | OAuth, token refresh + encrypted storage, Sheets reads |
| `src/lib/scheduler.ts` | In-process scheduler (checks every minute) |
| `src/lib/actions.ts` | Server actions (snapshot, baseline, schedule, settings) |
| `src/components/diff/diff-view.tsx` | The GitHub-style diff UI (client) |
| `src/lib/gaps.ts` | Auto gap report — chain reconstruction and reconciliation |
| `src/lib/detect.ts` | Station parsing + column auto-detection |
| `src/lib/production.ts` | Production analytics — dates, crews, TOTALS, aging |
| `src/lib/billing.ts` | The billing-day packet |
| `src/lib/db/migrate.ts` | Startup migrations (legacy DBs stamped non-destructively) |
| `data/sheetdiff.db` | SQLite database (snapshots as gzip'd JSON blobs) |

### How diffs stay honest

- Rows are identified by a **key column** when one exists (header like ID/Date/…, or any column
  whose values are unique). Without one, rows are matched by full-row content. Position is never
  used as identity — that's what makes re-sorts harmless.
- Columns are matched by header text, so inserting a column mid-sheet doesn't scramble cell
  pairing; a lone renamed header is paired instead of reported as remove+add.
- Values are compared trimmed, and numerically when both sides parse as numbers.
- Snapshots read via `values:batchGet` include every row/column regardless of filters — filters
  are a visual layer in Google Sheets, invisible to the API.

## Not in v1 (by design)

Excel *tracking* (imports are supported), direct InEight/ERP APIs, multi-workspace tenancy,
editing data, formula/formatting diffs. Each is a clean future addition — the data model and
scopes leave room.

## Contributing

Issues and PRs welcome — the diff engine (`src/lib/diff/`) and checks (`src/lib/checks.ts`)
are pure logic with full test suites, which makes them the friendliest place to start.
`npm test && npm run typecheck && npm run build` should pass before submitting.

## License

[MIT](LICENSE)
