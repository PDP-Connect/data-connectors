# Instagram empty-list work

## Progress

- Fetched `origin` and reset `waspflow/m1-ig-empty` to `origin/main` before editing.
- Read parked PRs #221, #225, and #227. Reusing #221's exact synthetic Accounts Center messages and #227's terminal timeline proof; not reusing blank-list settling or profile-count-only proof.
- Current defect: the ads collector accepts a mounted blank list after 2.5 seconds; the posts collector can treat unrelated or invalid GraphQL responses as empty and emits no completion state for a valid empty timeline.

## Evidence plan

- Ads: visible exact surface-specific empty copy inside a visible dialog containing a list (`No advertisers`, `No ad topics`, or `No categories`) proves empty. A visible list row proves populated. A blank shell, hidden copy, busy/loading state, or visible error does not prove empty and remains unavailable. Error copy takes precedence even when an empty marker is also present.
- Posts: only a successful matching posts timeline response with an array of zero source edges and `page_info.has_next_page === false` proves empty. HTTP/GraphQL errors, `status: "fail"`, missing/malformed connections, missing pagination proof, and no response remain failures.
- Synthetic fixtures will cover empty, populated, and failed responses. No live Instagram session is being used; the copy is sourced from the parked PR's synthetic fixtures and needs live confirmation before relying on it as live-site evidence.
- The independent review reproduced three additional edge cases: a `status: "fail"` timeline with empty edges, error copy beside an empty ads marker, and a zero-height list. Added regression assertions for each, then reran the Instagram integration suite (30/30 pass).
- Verification passed: `npm run verify --workspace @pdpp/polyfill-connectors`, `npm run connector-implementation-index:check`, `npm run historical-contract:check`, the Instagram integration suite (30/30), and the connector reason-display test (17/17).
- The full workspace test suite ran and found the new `posts_timeline_unavailable` reason lacked manifest display copy; added that copy and regenerated library metadata. A separate screenshot-redaction test failed once with a missing temporary PNG during a browser screenshot write, then passed when run alone. The full suite was not rerun after these fixes.
- Exact ads copy is supported only by synthetic fixture strings in parked PR #221; there is no retained live capture or live Instagram retest in this work. The implementation follows that prior synthetic evidence, but the exact live copy remains unconfirmed.
- Created a signed commit and opened draft PR [#266](https://github.com/PDP-Connect/data-connectors/pull/266). `TASK.md` remains untracked and is not in the commit.

STATUS: FINAL
