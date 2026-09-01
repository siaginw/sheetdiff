### SheetDiff v0.3.2

**Fixes a billing-dashboard crash at v0.3.1** and closes a billing-CSV correctness gap.

**Dedup unified** — one tested `dedupeTabData()` replaces three inline copies. Compilation tabs (Line List copies the working tabs) no longer double-count footage, holes, or the A/R backlog on any surface.

**Billing dashboard rebuilt + tested** — the page that 500'd at v0.3.1 is clean, with SSR tests pinning render, dedup, and section classification.

**New:** stoppage-aware weekly report (dip weeks annotated with logged stoppages); permit watch (designed-no-permit, unapproved crossings, submitted-aging); billing & report in the top bar with a billable-now badge; capture-failure health signal; legacy v0.2 upgrade fixed.

Suite: **312 tests**. Node 22+.
