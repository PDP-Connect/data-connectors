# GitHub browser record contract

All six streams keep their legacy aggregate envelopes and stable primary keys
`<username>:<stream>`. Unread fields are omitted, not filled with synthetic values.

## Source evidence

| Stream | Evidence for emitting the snapshot |
| --- | --- |
| profile | Validated profile identity and page navigation establish singleton presence. Embedded pinned repositories, organizations and achievements remain best-effort; no self inventory coverage or deletes. |
| repositories | Exact repository counter matching distinct rows, or explicit pagination end without a conflicting counter. |
| starred | Exact Stars counter matching distinct rows, or explicit pagination end without a conflicting counter. |
| events | Validated REST pages followed through an observed Link header without rel=next, or an empty page. Window: up to 300 events from the past 90 days. |
| history | Stable Search total_count, incomplete_results=false, validated distinct rows for both types. Exact total matching completes ordinary searches; totals above 1,000 complete on the observed API end or 1,000 distinct items in the documented per-type window. |
| contributions | Every requested view's exact heading total matches the sum of distinct day counts; four-view/date-window checks still apply. |

Short pages and local page budgets never prove completion. Missing header
observations are not the same as observing an absent Link header. Invalid,
duplicate, redirected, failed, or incomplete API responses withhold the inventory
snapshot. Abbreviated counters cannot establish exact totals.

## Incomplete runs

Incomplete inventories emit no RECORD, STATE or self DETAIL_COVERAGE and derive
no deletes, preserving the prior snapshot. The retryable
`inventory_not_proven_complete` SKIP_RESULT is supplied by a connector-local
compatibility helper (TODO #418). Profile presence is not an inventory claim.

PageShim's six-scope and streaming gates use internally consistent source totals
and explicit pagination evidence. The separate failed-starred-stream regression
still requires the stable omitted error. Tests cover partial profile lists,
observed REST pagination, unread continuations and capped history windows.

Live signed-in behavior and Personal Server projection parity are not verified here.
