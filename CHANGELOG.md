# Changelog

## 0.6.3 — 2026-09-05

**The clean-pass polish release.** The v0.6.2 audit found no CRITICAL and
no HIGH issues — the first clean pass — so this ships its MEDIUM/LOW
findings.

- ARCHITECTURE.md still taught the pre-0.6.2 ownership rule ("first tab in
  position order wins") — the exact sentence describing the bug 0.6.2
  fixed. Rewritten to richest-first with the trade-off spelled out; also
  removed a phantom `stoppages.ts` entry, fixed a garbled routes list, and
  added /settings and the PDF route to the HTTP surface.
- The SSRF guard's IPv4-mapped matcher is now STRUCTURAL (the "ffff"
  hextet followed by exactly two more, zeros before it) instead of a
  prefix string — non-canonical spellings like
  `0:0:0:0:0:ffff:7f00:1` are caught too, and non-canonical tails are
  refused rather than misread. Tests pin both.
- Digest check findings no longer run on pure-copy tabs (a copy's findings
  duplicated the working tab's — the email listed every hole twice).
- The failed-test flash names NOTIFY_ALLOW_PRIVATE_URLS=1; the invalid-URL
  flash says http(s); the onboarding "collection point" step's copy
  acknowledges the automatic first baseline.
- knip installed as a devDependency (the npx fetch was unlisted);
  settings page drops a redundant user query; test counts corrected in
  the docs; dead re-export cleanup.

Suite: **394 tests + 7 E2E**. Node 22+.

## 0.6.2 — 2026-09-05

**The guard-the-guard pass.** The v0.6.1 audit attacked v0.6.1's own fixes
and found them wanting; everything below is fixed and regression-tested.

- **CRITICAL — the SSRF guard itself was bypassable.** The WHATWG URL
  parser canonicalizes dotted IPv4-mapped IPv6 to HEX
  ("[::ffff:127.0.0.1]" becomes "::ffff:7f00:1"), so the dotted-only unwrap
  never fired on URL-derived hostnames — every guarded target was reachable
  via the hex spelling, including cloud metadata (::ffff:a9fe:a9fe).
  Mapped addresses are now parsed in both spellings (unparseable ::ffff:
  forms refused), and NAT64 (64:ff9b::/96), 6to4 (2002::/16), and CGNAT
  (100.64.0.0/10 — Tailscale) ranges are blocked too.
- **The DNS-rebinding window is closed for the guarded path**: plain http
  URLs are now refused unless NOTIFY_ALLOW_PRIVATE_URLS=1 is set — a
  rebound connection cannot complete TLS without a hostname-valid
  certificate, and LAN ntfy users already have the opt-in. The push
  response body is released so sockets pool promptly.
- **"Line List FIRST" no longer flips the billing basis.** Compilation
  tabs re-list with FEWER columns (the real Line List: 20 vs the PE tabs'
  23); with raw position order, a compilation preceding the tabs it copies
  owned everything and the WORKING tabs became its copies — measured on
  the real tracker: 208,961 ft placed-since and zero holes instead of the
  true 55,683 ft / 28,299. Ownership now runs richest-tab-first (column
  count, then position); same-width sheets behave exactly as before.
  Verified on the real file: Line List first, last, or absent all produce
  identical billing packets.
- **Import-quiet push suppression is per-tab**: an import between one
  tab's base and now silences only that tab's "changes"; genuine changes
  on clean tabs still notify (a sheet-wide max silenced them).
- **The 0.6.1 honesty fixes actually render now** (they didn't): failed
  test pushes and invalid URLs show their messages on /settings, and an
  invalid entry never clears a previously saved topic.
- Pino redaction: restores the req.headers paths 0.6.1 dropped, adds
  err.response.data / err.config.headers censors, and the comment now
  tells the truth about wildcard depth (single-segment only).
- .env.example documents LOG_LEVEL and NOTIFY_ALLOW_PRIVATE_URLS; dead
  STEP_ICONS export removed.

Suite: **394 tests + 7 E2E**. Node 22+.

## 0.6.1 — 2026-09-05

**Security and honesty fixes from the v0.6.0 audit pass.** The audit's
headline: the push-notification URL was a full SSRF surface, and the
Temporal date port claimed in 0.6.0's notes had never actually landed (an
aborted edit script — the changelog lied). Both corrected, among others.

- **SSRF guard on push URLs.** The server fetches a user-controlled URL —
  it is now treated as hostile: the hostname is RESOLVED AT SEND TIME and
  every address is refused if loopback, link-local (which includes the
  cloud-metadata 169.254.169.254), RFC1918, ULA, unspecified, or
  IPv4-mapped; redirects are refused outright; non-canonical IPv4
  spellings (2130706433, 0x7f.1) die at resolution. Deployers running
  ntfy on the same LAN can set NOTIFY_ALLOW_PRIVATE_URLS=1 explicitly.
- **parseCompletedDate now really validates via Temporal.PlainDate** with
  overflow:"reject" (the default CLAMPS Feb 30 to Feb 28 — the silent
  rollover, reintroduced). The 0.6.0 note claimed this; the code didn't.
  The full existing date battery pins the behavior.
- Captures after a GIS IMPORT stay quiet: their "changes" are the rows
  the office just imported — announcing them as new work was backwards.
- The push is fire-and-forget: a dead ntfy endpoint can no longer add its
  5s timeout to a capture or the sequential scheduler tick.
- Pino redaction covers NESTED credential paths (err.response.data.*
  access tokens, err.config.headers.authorization); google.ts logs
  err.message, never the raw gaxios error object.
- The billing PAGE now sees an untracked TOTALS tab's over-placement
  exactly like the CSV and PDF always did (it queried tracked tabs only).
- "Test notification" reports failure honestly; an invalid URL is
  rejected with a message instead of silently cleared. Pure viewers no
  longer see the onboarding checklist (steps they can never complete).
- knip-clean: pino-pretty removed, temporal-spec declared, dead exports
  dropped; pino externalized from the server bundle.

Suite: **391 tests + 7 E2E**. Node 22+.

## 0.6.0 — 2026-09-04

**The workflow release: push notifications, PDF billing packets, a settings
hub, and onboarding — plus Temporal-based date math and real-HTTP Google
client tests.** Eight researched integrations, each one vetted to actually
fit before shipping.

- **Push notifications (ntfy).** Settings → Push notifications: subscribe to
  a topic on your phone, paste the URL, hit the built-in test. Captures that
  introduce changes buzz instantly (first-capture baselines stay quiet);
  quiet captures never ping. Validated http(s) URLs only, 5s timeout,
  failures logged and swallowed — a push can never fail a capture.
- **PDF billing packet.** The billing page gains a PDF button next to CSV —
  a printable, fileable artifact built from the SAME packet assembly (one
  source of truth extracted into billing-packet-source), on the same data
  clock, so PDF and CSV can never disagree.
- **Settings hub + onboarding.** All user settings on one /settings page
  (push, digest, server-settings pointers), linked from the account menu.
  A four-step getting-started checklist on the dashboard derives its
  completion from the database (track a sheet → mark a collection point →
  notifications → sharing) and auto-hides when done or dismissed.
- **Temporal date math.** parseCompletedDate validates via
  Temporal.PlainDate — an impossible calendar date now THROWS instead of
  relying on hand-rolled day-count checks — and week bucketing computes
  Mondays with Temporal day arithmetic, killing the DST-crossing drift the
  ms-subtraction could produce. Output contracts unchanged (local-midnight
  Dates), all 370 tests untouched.
- **Structured logging (Pino).** One logger with token redaction replaces
  every server-side console.log — greppable JSON in `docker logs`, level via
  LOG_LEVEL.
- **MSW tests for the real Google client.** Five tests exercise the actual
  googleapis wire path (range quoting, 10-chunk batching, response pairing,
  the reorder abort, empty-grid handling) instead of a module mock that
  bypassed all of it.
- **Weekly report chart (Recharts).** The report's footage-per-week sparkline
  is now a real bar chart with tooltips — same deduped weeklyProduction
  numbers, drawn.
- README: notifications & monitoring guide (ntfy, Uptime Kuma via the
  existing HEALTHCHECK_PING_URL, Litestream disaster-recovery compose
  recipe).

Suite: **381 tests + 7 E2E**. Node 22+.

## 0.5.2 — 2026-09-04

**Playwright E2E + two pre-existing accounting bugs the fresh audit pass
surfaced.** The v0.5.1 fixes all held under attack; the findings below
predate them.

Fixed:

- **Permit deny-list typo failed OPEN**: `nots+` in the negative-status
  regex should have been `not\s+`, so "Not Issued" / "Not Approved" / "Not
  Released" matched the APPROVED vocabulary instead — placed-under-
  unapproved findings were silently missed on exactly the permits that
  say no. Negations are now denied, with tests pinning the vocabulary.
- **Header drift could key history by the wrong column**: the resolved
  identity columns are indices, and a column inserted/removed since a
  baseline shifts every index after it — the slice walk now drops to the
  content tier whenever the slice's header at the resolved index isn't
  the column the latest walk keyed on.
- "Day No"/day-family headers join date/week as date-ish (a day-number
  column no longer becomes row identity and collapses two same-week
  logs); the token refresh preserves the stored access token when a
  tokens event omits it; coverage thresholds leave ~1% of ratchet margin.

Dev environment (round 2, researched):

- **Playwright smoke E2E**: five tests against the production build —
  health, the public landing, demo login → dashboard, the sheet diff
  view, report + billing pages. Runs on its own port with a throwaway
  temp-dir database (never the real one); CI job uploads the HTML report
  on failure. `npm run test:e2e`.
- `typecheck` runs `next typegen` first (Next 16's own recommendation).
- `db:studio` (Drizzle Studio) script; CI badge in the README.
- The docker boot-probe job now builds arm64 too (free for public repos —
  and matches how self-hosters actually deploy: NAS and Pi).

Suite: **369 tests + 5 E2E**. Node 22+.

## 0.5.1 — 2026-09-04

**Identity-layer hardening + a real dev environment.** A fresh adversarial
audit of v0.5's smart-identifier hierarchy found five real defects (all
fixed, all regression-tested); a researched pass over comparable open-source
Next.js repos added the standard 2026 tooling this project was missing.

Fixed:

- The auto-detected key column was re-detected per SNAPSHOT, not resolved
  once on latest data — when uniqueness flipped between slices (two rows
  share a date on the baseline), the same row keyed differently over time
  and a copy tab's baseline escaped ownership, deflating placed-since. Both
  identity columns now resolve on latest and thread through every slice.
- Date/week columns no longer outrank real identifiers in detection scoring,
  and the dedup's auto-tier skips them entirely (a date identifies a DAY —
  two crew logs spanning the same period used to collapse into one tab and
  vanish from billing). A deliberately chosen date key is still honored.
- `sheetBillableNow` ignored the per-tab key column — the badge and the
  money page could disagree, the exact invariant it exists to guarantee.
- A 95%-copy tab that owned more than ~2% of its rows was still skipped as a
  pure compilation tab, dropping its own work from every rollup; the
  coverage branch now caps strays at 2% (the real Line List sits at 1.9%).
- The slice walk's key-namespace exception was inverted: within-tab repeats
  were dropped and cross-tab repeats kept — removals now net out per tab.

Dev environment (researched against cal.com, dub, formbricks, documenso,
vitest, drizzle-orm): Prettier with Tailwind class sorting + import
organizing (repo formatted once, `npm run format`/`format:check`), husky +
lint-staged pre-commit (ESLint --fix + Prettier on staged files), Vitest v8
coverage with enforced thresholds, an aggregate `npm run verify`, knip for
dead code (6 unused scaffold components removed), CodeQL + zizmor security
workflows, hardened CI (least-privilege permissions, cancel-in-progress,
timeouts, persist-credentials off, format + coverage steps), `.nvmrc`,
`.editorconfig`, `.vscode` recommendations, PR template, feature-request
form, FUNDING. The phantom `google-auth-library` type import is now derived
from `googleapis` itself.

Suite: **367 tests**. Node 22+.

## 0.5.0 — 2026-09-02

**Works with any sheet.** SheetDiff's core loop was always sheet-agnostic;
the identity layer wasn't. Row identity now runs through a smart hierarchy —
your chosen key column (validated: populated + unique, or ignored), then
activity+stations, then an auto-detected ID column (vocabulary widened:
Order, Part, Invoice, Asset, Serial, Email, Client, Customer, Account,
Request, Case, Batch, Lot, License, Permit), then whole-row content — with
content registered alongside every tier so verbatim copies match regardless
of how each side keyed. The identity tier is decided ONCE on latest data and
applied to baselines and window walks; per-slice resolution could key the
same row differently at different times and inflate placed-since (caught by
a fixture while shipping this).

- Same key twice in one tab = two rows, not a duplicate (two warehouse lines,
  one SKU); across tabs it still counts once.
- Generic sheets are honest about the math: the billing page/CSV says
  "COULD NOT DETERMINE — no collection marker or no station columns
  (row-based sheet)" instead of a confident 0 ft; the to-enter worklist,
  acks, digest, and copy-tab detection work identically.
- New acceptance suite: a generic inventory sheet (no stations, no
  construction vocabulary) — copy classification via auto-detected SKU
  column, every count surface agreeing, honest billing output.
- Construction path re-verified against the real tracker: PE-only and
  PE+Line-List configurations still export identical billing packets.
- Wording: "one row per entry" (was "per shot") in the typing list and its
  menu label; the tab-settings dialog explains what "Match rows by" drives.

Suite: **361 tests**. Node 22+.

## 0.4.0 — 2026-08-30

**The accounting-grade release.** A five-agent accuracy audit (number
correctness, adversarial fuzz, data integrity, cross-surface invariants, and
a forensic pass against a real 36-package production tracker) verified every
computation path end to end — and found the dedup layer between the tabs and
the money numbers was not safe for high-dollar use. Measured on the real
tracker, tracking the compilation tab alongside the working tabs produced
910,210 ft of placed footage where the true number was 459,472 ft (+98%).
Everything the audit found is fixed, and the fixes are enforced by a new
permanent invariant suite that seeds one sheet and asserts every surface —
dashboard, sheet page, three CSVs, billing page, report, digest — shows the
SAME numbers, hand-computed independently from the seed data.

- **Identity-keyed cross-tab dedup** (`src/lib/dedupe.ts`). Rows key on work
  identity (activity + parsed stations — survey notation "2+14", thousands
  separators, and retyped crews all match the working tab's "214"), with a
  content-key fallback for station-less tabs. Ownership is decided once on
  latest data and applied to baselines and window walks too, which makes both
  the double-count and the "-25,000 ft placed since collection right after
  collecting" bug structurally impossible. Compilation tabs (≥95% owned
  content) are skipped by every rollup AND every to-enter count — one
  classifier, so no two surfaces can ever disagree; their reformatted strays
  surface as a check finding instead of vanishing. Verified against the real
  tracker: PE-only and PE+Line-List configurations now export IDENTICAL
  billing packets.
- **Byte-identical exports.** Every stamp, aging day-count, and filename date
  derives from the DATA clock (the latest snapshot), never the export moment —
  the same data re-exports to identical bytes, and the billing page reads the
  same clock so the screen and the file cannot disagree.
- **Exact undo.** "Mark as collected" captures the per-tab baseline state in
  a validated token; the new `undoBaseline` restores it in one transaction.
  Mixed per-tab baselines (a tab added later) used to restore only some tabs
  and silently hide un-entered work behind a success flash.
- **Never-silent dates and stations.** "Feb 30 2026" (any month-name form,
  weekday-prefixed or day-first) is unreadable, not March 2nd — it used to
  mis-age A/R by days. Stations beyond 1e9 ft are not stations; two absurd
  cells can no longer sum to Infinity footage. 130k-row sheets no longer
  crash the diff, capture, or gap report (`Math.max(...spread)` → loops).
- **CSV hardening.** LF end to end (a CRLF/LF mix used to leave `15743
` on
  re-import), pure numbers exempt from the formula guard (`-65` ft
  corrections round-trip), billing packets stamped with their run id.
- **Complete invoice ledger.** 1–2 digit invoice numbers land in the billed
  ledger; anything keyed downstream that matches no recognizable bucket is
  SURFACED (row, value, column) instead of silently vanishing.
- **Capture integrity.** A reordered Google batchGet response aborts the
  capture instead of storing one tab's rows under another tab.
- **One placed definition.** The footage ledger, weekly buckets, and the gap
  report's money number all use the same chain rule.

Suite: **353 tests** (24 new, including the cross-surface invariant suite and
a real-file acceptance harness). Node 22+.

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

Fleet 12: the weekly report no longer blanks when a tracked tab copies another
(the dedup used `return` where it meant `continue` — the stock demo triggered
it); the report uses the TESTED dedup helper and computes placed-footage from
deduped rows (copies no longer double-count); month-name invoice markers are
year-aware ("December" viewed in January is now correctly a missed run);
invoice-ledger ft no longer inflates on unparseable stations; a row keyed via
Invoice # alone is billed, not billable; the panel renders a full invoice
section (billable rows, billed-by-invoice ledger, missed runs) and its
clean/empty states account for it; billing route decodes each tab's blob once
(was 4x); Dependabot PRs triaged (TS 5.9 stays for this release — TS 7 breaks
next build on 16.3); social-preview image composed; suite 282.

Fleet 12.5 (roadmap #1+#2 + the dashboard): BILLING DAY DASHBOARD at
/sheets/[id]/billing — the packet as a one-screen triage page (headline
cards: placed-since / billable-now / open-hole ft / to-enter; sections
ordered blockers-first: do-not-invoice → billable → missed runs → office
backlog → late entries) with print and CSV from the same data. SNAPSHOT
DECODE LRU — decoded grids cached by immutable snapshot id (64MB default,
SHEETDIFF_SNAPSHOT_CACHE_MB=0 disables, dev builds deep-freeze to catch
mutation), adopted in the pending resolver so all seven call sites inherit
(measured 609ms→1ms warm on tracker scale). CAPTURE-HEALTH PAIR —
capture_fail_streak / last_capture_error columns (migration 0001), success
resets inside the capture transaction, failures recorded best-effort,
/api/health gains failingCaptures, the sheet header shows an amber line with
the error. Component tests live: jsdom + RTL + user-event installed, the
note-dialog prefill/reset contract is the first .test.tsx. Suite 287.

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

_(Superseded in 0.3.0: migrations apply automatically on startup — just `git pull` and restart.)_
