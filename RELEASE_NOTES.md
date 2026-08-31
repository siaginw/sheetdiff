### SheetDiff v0.3.1

Four features built around the office that keys your sheet into the billing system:

**Entry queue export** — one CSV row per *shot*, in the tab's own column order, oldest first; removed rows ship as delete-downstream summaries. The typing list for the person keying into InEight/ERP, not a cell-change log.

**Office pipeline + invoice ledger** — reads your sheet's own "Entered in InEight", "Invoice #", and GIS columns: what's billable right now (aged, with footage), what's billed under which invoice number, what's queued for a named monthly run, and runs already missed.

**Weekly production report** — printable `…/report` one-pager: footage per week as dated by crews, week-over-week delta. Compilation tabs (Line List) are deduped so nothing double-counts.

**Billing day dashboard** — `…/billing`: the packet as a one-screen triage page — billable-now, open holes (do-not-invoice), missed invoice runs, office backlog — blockers first, printable, with the CSV one click away.

**Trust & hardening:** every rowKey identifies exactly one row (one ack can never swallow a second change); staleness visible everywhere "up to date" appears, incl. `/api/health`; "Mark as collected" is atomic, ack-aware, and asks before clearing unentered work; zip-bomb guard closes the EOCD count-lie hole; account-menu dialogs actually open on production builds; OAuth guidance fixed — publish to production-unverified (Testing tokens die at 7 days); crew canonicalization; over-placement do-not-invoice guard; formula-injection-guarded exports; dead-man ping bounded and only after successful captures; capture-failure health (`failingCaptures`); dark-mode printing; PRIVACY.md + SECURITY.md.

**Ops:** Node 22+ required (engine-strict); CI green on Node 22+24 + Docker; snapshot decode LRU (64MB default); Dependabot live. Suite: **287 tests**.

**Upgrade:** `git pull && docker compose up -d --build` (or `npm ci && npm run build && npm start`). Migrations apply automatically on boot.
