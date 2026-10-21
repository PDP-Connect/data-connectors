# GitHub browser record contract

All six streams keep their legacy aggregate envelopes and stable primary keys
`<username>:<stream>`. Unread fields are omitted, not filled with synthetic values.

## Source evidence

| Stream | Evidence for emitting the snapshot |
| --- | --- |
| profile | Validated profile identity, page navigation and readable nested collections establish singleton presence. Unreadable pinned repository, organization or achievement entries withhold the snapshot; no self inventory coverage or deletes. |
| repositories | Readable, unique entries across every page, plus an exact repository counter matching distinct rows or explicit pagination end without a conflicting counter. |
| starred | Readable, unique entries across every page, plus an exact Stars counter matching distinct rows or explicit pagination end without a conflicting counter. |
| events | Validated REST pages followed through an observed Link header without rel=next, or an empty page. Window: up to 300 events from the past 90 days. |
| history | Stable Search total_count, incomplete_results=false, validated distinct rows for both types. Exact total matching completes ordinary searches; totals above 1,000 require exactly 1,000 distinct items in the documented per-type window. An earlier API end does not prove that window complete. |
| contributions | Every requested view's exact heading total matches the sum of distinct day counts; four-view/date-window checks still apply. |

Short pages and local page budgets never prove completion. Missing header
observations are not the same as observing an absent Link header. Invalid,
duplicate, redirected, failed, or incomplete API responses withhold the inventory
snapshot. Abbreviated counters cannot establish exact totals.

Starred inventories can also use REST enumeration through an observed Link end
or an empty first page. Its distinct repository identities must match the browser
rows. Every validated exact counter from the primary and fallback routes remains
binding; conflicting counters or a row-count mismatch withhold the snapshot.

`InventoryEvidence` owns completeness for repository/starred inventories and all
three embedded profile collections. Profile layout parsing supplies located, absent
or ambiguous boundaries and accounts for surviving candidates across the profile,
including candidates outside the selected region. A heading only locates content;
it cannot prove an empty collection. A heading without a located region remains
ambiguous. Rejected or unclaimed candidates block publication.
For repositories/starred, evidence stays binding across routes and pages. Rejected
entries, duplicate identities (even unchanged rows), and later pages
without new identities remain failures even if a later page or counter looks complete.
An empty first page can prove an empty inventory; an empty later page cannot repair
an interrupted traversal. Events, history and contribution calendars retain their
own documented source-window proofs.

## Incomplete runs

Incomplete inventories emit no RECORD, STATE or self DETAIL_COVERAGE and derive
no deletes, preserving the prior snapshot. The retryable
`inventory_not_proven_complete` SKIP_RESULT is supplied by a connector-local
compatibility helper (TODO #418). Incomplete profile collections also withhold RECORD and STATE and emit the retryable `github_browser_incomplete` SKIP_RESULT. Absent optional scalars remain omitted. Profile presence is not an inventory claim.
Skip diagnostics retain the safe cause, source or sink origin, and coverage counts.
API failures also retain the HTTP status when available. A failed history type
stops the search; profile failures identify the collection and evidence cause. Raw exception messages
are excluded.

PageShim's six-scope and streaming gates use internally consistent source totals
and explicit pagination evidence. The separate failed-starred-stream regression
still requires the stable omitted error. Tests cover withholding partial profile lists,
observed REST pagination, unread continuations and capped history windows.

The profile parser accepts the pinned-card marker on either the list item or its
inner wrapper. Residual pin accounting is bounded to pinned containers and card markers;
repository links in a README, bio or contribution activity are separate from pins. A structure-only fixture derived from a
2026-10-20 recording covers the list-item form.
Organization and achievement fallback hooks also exclude README, bio and overlay
content, so unrelated links cannot turn an absent section into extraction failure.

Live signed-in behavior and Personal Server projection parity are not verified here.
