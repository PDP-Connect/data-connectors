# polar_flow fixtures

Synthetic. No real Polar data. **Inferred, not yet captured from a live account.**

No Polar Flow account was available when the connector was written. What is verified, on
11 November 2026 without signing in:

- Every endpoint below exists and answers `401` (JSON `{"error":"NotAuthenticated",...}`) without
  the session, where an unknown `/api/...` path answers `404` HTML.
- `sleep-api.flow.polar.com` answers a CORS preflight from `https://flow.polar.com` with
  `access-control-allow-credentials: true` and `access-control-allow-headers: x-requested-with`.
- The paths, methods and parameters are the ones the current web app bundle
  (`flow.polar.com/flow-ui-mono/static/js/index.*.js` and the Nightly Recharge chunk) builds.

The envelopes, key names and each value's JSON type are inferred from two sources: that bundle
(for Nightly Recharge: `date`, `recoveryIndicator`, `ansStatus`, `ansRate`, `rri`, `rmssd`,
`respirationInterval` and their `28dayAverage` siblings, and the web app's own sanitising of
`ansRate` outside 1 to 5), and the reverse-engineered OpenAPI description in
`lmgarret/polar-flow-mcp` (`internal/flow/openapi.yaml`, Apache-2.0, last pushed 7 November 2026),
which records responses from a device-less test account and the bundle's reading of the populated
shapes. Every value here is invented. Shapes for populated sleep and Nightly Recharge rows were not
observed by either source on an account with a Polar device; treat them as the least certain.

Kept on purpose, unread: the login e-mail (`userName`), picture URLs, GPS coordinates, samples,
timeline icons and report URLs.

| File | Endpoint |
|---|---|
| `current-user.json` | `GET /api/account/users/current/user` |
| `training-history.json` | `POST /api/training/history` with `{"userId","fromDate","toDate"}` (days inclusive) |
| `training-summary-<id>.json` | `GET /api/training/analysis/{id}/summary` |
| `activity-loadfour.json` | `GET /api/activity-timeline/loadFour?day=…&maxSampleCount=200` (answers `[day-2, day+1]`) |
| `sleep-report.json` | `GET https://sleep-api.flow.polar.com/api/sleep/report?from=…&to=…` (30 to 365 days) |
| `nightly-recovery.json` | `GET /api/nightly-recovery/{from}/{to}` (404 when the range holds nothing) |

Every request carries `X-Requested-With: XMLHttpRequest`, as the web app sends it: Flow's CSRF
guard and the sleep API both require it.

The account's UTC offset is `+02:00`. The first training session carries Polar's blank note
(`" "`), which reads as no note. The second is a manual entry: no heart rate (Polar reports `0`),
no device, no name, and no distance anywhere but its exercise's `0`. The third activity day is all zeros with no
sync (a day no device recorded, which builds no record); the fourth is past the last sync
(`dataPanelData: null`). The second Nightly Recharge night has an `ansRate` of 0, which the web app
treats as no rating and no ANS charge.

Checked on 12 November 2026 against a live, device-less account with three manual entries: every
endpoint above answers in the shape these files use (sleep `[]`, Nightly Recharge a bare `404`,
activity days with no sync), and a manual entry's distance is null in the list and the summary and
present only on `exercises.<id>.distance`, in metres (`0` when the entry has none).

`../fake-polar.ts` serves these files to the tests.
