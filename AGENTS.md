# SheetDiff — contributor notes

Node 20+, npm. `npm install && npm run setup` to start. The full local gate:
`npm test` (121 domain tests), `npm run typecheck`, `npm run lint`, `npm run build` must pass.
The diff engine (`src/lib/diff/`) and checks (`src/lib/checks.ts`) are pure logic with full test
suites — start there. Schema changes: edit `src/lib/db/schema.ts`, run `npm run db:generate`,
commit the `drizzle/` folder (CI enforces no drift).

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
