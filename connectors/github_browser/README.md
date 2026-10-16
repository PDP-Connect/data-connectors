# GitHub browser record contract

All six streams keep their legacy aggregate envelopes and the stable primary key
`<username>:<stream>`. Repository, starred, event, contribution and history
fields keep their existing names. Missing unread values are omitted, never filled
with synthetic zeroes or empty strings.

## Source evidence

A successful snapshot requires an exact source total matching distinct items read,
or GitHub's explicit pagination end on the last page walked. Layout, unknown text,
empty-state copy, row accounting and blocked-page text do not establish or veto
inventory completeness. Ownership, navigation and record validation still apply.

| Stream | Completeness evidence |
| --- | --- |
| repositories | Exact Repositories tab counter across distinct repos on walked pages; otherwise GitHub pagination with next disabled or absent within the component |
| starred | Exact Stars tab counter across distinct repos on walked pages; otherwise the same explicit pagination end |
| contributions | Exact contribution heading total equals the sum of distinct calendar day counts in every requested view; the existing four-view/date-window contract remains |
| history | Search API `total_count` equals distinct IDs for both issue and PR searches, with `incomplete_results: false` and a stable total |
| profile | None in supplied fixtures for the embedded pinned/organization/achievement inventories; aggregate withheld |
| events | None in supplied REST-array fixtures; a short page or a 300-item cap is not an explicit source end; aggregate withheld |

Abbreviated counters such as `1.2k` cannot prove an exact total. A mismatching exact
counter cannot be overridden by pagination. Exactly 1,000 search items may complete
when the API states exactly 1,000 and all items are read; a larger count cannot.

## Incomplete runs

Every stream is one aggregate snapshot. An incomplete run emits no RECORD, no
STATE and no self DETAIL_COVERAGE, and performs no deletes. This preserves the
previous complete snapshot. It emits the retryable `inventory_not_proven_complete`
SKIP_RESULT through `fullInventoryCoverage` with an incomplete enumeration.
Readable staged items are not flushed on failure.

The PageShim regression requests only the incomplete starred stream and expects
an omitted error with that stable reason. Profile and events cannot have truthful
positive-completeness fixtures until real source evidence for their exact
inventories is available. Tests explicitly verify that unrelated profile counters
and short event arrays do not grant authority.

Field-parsing and runtime protocol tests establish the branch record contract;
live signed-in behavior and Personal Server projection parity are not verified here.
