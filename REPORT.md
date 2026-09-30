# Strava PageShim scope payload

## Progress

- Fetched `origin` and fast-forwarded `waspflow/m2-strava-mobile` to `origin/main` before implementation.
- Confirmed `strava_browser` is version `0.1.3`; the PageShim fixture resolver already serves activity detail and heartrate stream routes.
- Added a regression for the stored `strava.activities` payload. It failed on `{ records: [...] }` and passed after the PageShim adapter and summary switched to `{ activities: [...] }`.
- Added a Desktop parity driver that runs the production collector and record validator against the same synthetic fixtures.

## Final result

PageShim now emits `{ "activities": [...records] }` for `strava.activities`. The harness checks the exact scope envelope and compares it to the Desktop collector payload for the same initial synthetic inventory. The existing fixture resolver serves detail and stream requests for the connector's backfill path.

Checks:

- `node --test scripts/pageshim/pageshim.test.mjs` — 37 passed.
- `node --test connectors/strava_browser/index.test.ts connectors/strava_browser/details.test.ts connectors/strava_browser/parsers.test.ts` — 29 passed.
- `git diff --check` — passed.

The parity assertion covers the initial inventory run. The connector's own tests cover the list-first/detail-backfill behavior, including resumed detail work.

STATUS: FINAL
