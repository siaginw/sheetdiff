# Contributing to SheetDiff

Issues and PRs welcome. The diff engine and checks are pure logic with full
test suites — the friendliest place to start. [ARCHITECTURE.md](ARCHITECTURE.md)
explains how the systems fit; this file gets you productive.

## Setup

Requires Node.js 20+.

```bash
git clone https://github.com/siaginw/sheetdiff.git && cd sheetdiff
npm install
npm run setup        # creates .env with a random APP_SECRET
npm run dev          # http://localhost:3000
```

A fresh dev database (`data/sheetdiff.db`) is created automatically on first
boot — `src/instrumentation.ts` applies the committed migrations in `drizzle/`
before the app serves anything.

To actually track sheets you need Google OAuth credentials — follow the README's
"Google setup" section. **No Google account handy?** Use the demo:

```bash
npm run seed-demo
# set ENABLE_DEMO=1 in .env, restart, open http://localhost:3000/auth/demo
```

## The full local gate

Everything CI runs — all five must pass before you submit:

```bash
npx drizzle-kit generate && git diff --exit-code -- drizzle/   # migration drift check
npm run typecheck
npm run lint
npm test
npm run build
```

CI also builds the Docker image, probes `/api/health`, and verifies a page renders.

## Where to start reading

In order — each step assumes the previous:

1. [ARCHITECTURE.md](ARCHITECTURE.md) — the map.
2. `src/lib/db/schema.ts` — every domain concept is a column here.
3. `src/lib/diff/engine.ts` + `diff/normalize.ts` — pure, fully tested, the heart.
4. `src/lib/checks.ts` — the gap linter, same purity.
5. `src/lib/snapshots.ts` — capture, storage, schedules, stats.
6. `src/lib/pending.ts` + `sync.ts` — the audit workflow core.
7. `src/lib/actions.ts` + `access.ts` — the web layer and permission gates.
8. `src/lib/scheduler.ts`, `maintenance.ts`, `digest.ts` — the always-on loop.

## Schema changes

1. Edit `src/lib/db/schema.ts`.
2. Run `npm run db:generate` — this writes `drizzle/000N_*.sql` and updates
   `drizzle/meta/_journal.json`. **Commit both.**
3. That's the whole deployment story: migrations apply automatically on every
   boot, so `git pull && restart` upgrades any real deployment.
4. CI's drift check fails the PR if schema and migrations disagree.

Rules: never hand-edit `drizzle/`; additive only (existing rows must survive);
`db:push` is a dev scratch-database tool, never an upgrade path.

## Test harness pattern

Two kinds of tests, both vitest, colocated as `*.test.ts`.

**Pure logic** — no mocks, no I/O. Just describe/it over the module.

**DB-backed** (`*.db.test.ts`): set `DATABASE_PATH` to a temp file BEFORE
dynamically importing `./db`, push the schema with `drizzle-kit push --force`,
mock `next/*` and `./google`, then seed with `encodeSnapshot(toSnapshotData(grid))`
blobs. See `actions.db.test.ts` for the canonical contract. The first test
asserts the connection really points at the temp file.

Throwaway probes are fine locally but must be deleted before committing.

## Invariants worth keeping

- **Position is never identity.** Rows match by key, composite key, or content
  hash — sorting a sheet must produce `moved`, never false changes.
- **The engine does no I/O.** Everything in `src/lib/diff/` stays pure.
- **Google is read-only.** The OAuth scope stays `spreadsheets.readonly`.
- **Migrations fail closed.** A drifted schema aborts boot.
- **Stats are an optimization.** Any consumer of `snapshot_stats` must tolerate
  holes by falling back to the full diff.
- Never commit `.env` or `data/`.

## PR checklist

- [ ] Full local gate passes
- [ ] Schema change? Migration generated and committed
- [ ] New logic covered by tests
- [ ] No probe files or files reading outside the repo
- [ ] README + ARCHITECTURE updated if behavior changed
