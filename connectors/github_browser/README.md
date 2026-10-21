# GitHub browser record contract

All six streams keep their legacy aggregate envelopes and stable primary keys
`<username>:<stream>`. Unread fields are omitted, not filled with synthetic values.

## Source evidence

| Stream | Evidence for emitting the snapshot |
| --- | --- |
| profile | Validated profile identity, page navigation and readable nested collections establish singleton presence. Unreadable pinned repository, organization or achievement entries withhold the snapshot; no self inventory coverage or deletes. |
| repositories | Readable, unique entries across every page, plus an exact repository counter matching distinct rows or explicit pagination end without a conflicting counter. |
| starred | Readable, unique entries across every page, plus an exact Stars counter matching distinct rows or explicit pagination end without a conflicting counter. |
| events | Validated, distinct REST rows on every page of one walk, ending on a bound Link header without rel=next, or an empty first page. Window: up to 300 events from the past 90 days. |
| history | Stable Search total_count, incomplete_results=false, validated distinct rows for both types. Exact total matching completes ordinary searches; totals above 1,000 require exactly 1,000 distinct items in the documented per-type window. An earlier API end does not prove that window complete. |
| contributions | Every requested view's exact heading total matches the sum of distinct day counts; four-view/date-window checks still apply. |

Short pages and local page budgets never prove completion. Missing header
observations are not the same as observing an absent Link header. Invalid,
duplicate, redirected, failed, or incomplete API responses withhold the inventory
snapshot. Abbreviated counters cannot establish exact totals.

Every Link relation must name the request's own endpoint and selection. GitHub
names a user's list by account id (`/user/<id>/starred` for
`/users/<login>/starred`). The only supported continuation is the next page
number. The walk then requests its own owner-bound URL for that page, not the
header's target. The account id itself cannot be checked against the login,
so it selects nothing; only the login URL is requested. An absent Link header
ends only a first page; on a later page, only a `prev` link without `next` or
`last` ends the walk. A skipped page, a cursor, another login path or endpoint, a
changed selection, or unreadable or uncaptured metadata stops the walk and
withholds the snapshot. A `last` page that any page advertises binds the whole
walk: a later page that advertises a different last page, ends early, or
continues past it withholds the snapshot. Search history also needs every identity in its stable
window when the walk ends.

Starred inventories can also use REST enumeration through an observed Link end
or an empty first page. Its distinct repository identities must match the browser
rows. Every validated exact counter from the primary and fallback routes remains
binding; conflicting counters or a row-count mismatch withhold the snapshot.

One `InventoryEvidence` instance owns each inventory walk: repositories, starred
(browser and REST), events, each history search type, and each embedded profile
collection. It issues every request, so a walker can't name or skip a page. It
also records every page observation and decides the end proof. Walkers only
report what they observed. Evidence is append-only: the first negative
observation is the verdict, no later page, total or enumeration clears it, and
the walk issues no further request. Profile layout parsing supplies located, absent
or ambiguous boundaries and accounts for surviving candidates across the profile,
including candidates outside the selected region. A heading only locates content;
it cannot prove an empty collection. A heading without a located region remains
ambiguous. Rejected or unclaimed candidates block publication.
Repository and starred rows share one entry boundary. A row claims its entry only
with one heading identity, no nested list item, `role="listitem"` element or
starred card, and no other repository link except in its description or
"Forked from" line, outside its overlays. Headings inside hidden content or a lazy
fragment (whose loading or error template GitHub swaps in later, such as a
repository's sparkline) do not count, but nested entries and links there still
do. Otherwise the whole row is rejected, so no entry can hide inside
an accounted row.

Browser pagination continues only through an enabled Next control. Numbered page
links may sit beside it: several next controls must name the same page, and the
walk may not end before the highest page any page linked to. Forward numbered
links without an enabled Next withhold the snapshot. GitHub paginates stars lists
longer than one page with `after=` cursors, which are not followed yet, so those
lists are withheld; a single page of stars publishes.
The walk checks the linked-page floor for every successful decision, including
retained exact totals and REST reconciliation. First-page fallback observations
enter the owner before it selects a payload: every observed identity remains a
lower bound on that inventory. A smaller alternate payload cannot publish unless
later pages account for the missing identities. Payloads from partial routes are
not unioned. The same invariant check rejects cursor-bearing successors, including
a Next URL that also has a numeric page, before the walk issues another request.
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
