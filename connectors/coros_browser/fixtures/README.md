# coros_browser fixtures

Synthetic. Every value is invented; no real account was read.

**The shapes are inferred, not captured.** They were reconstructed on 2026-11-11 from the COROS
Training Hub web bundle (t.coros.com, app version 2.12.0, `main-*.js` and its lazy chunks): the
endpoint paths, query parameters, envelope (`{ result: "0000", message, data }`) and the field
names the bundle reads off each answer. Values, units and any field the bundle does not touch are
guesses until a live account confirms them. Replace these files with scrubbed live answers after
the first signed-in `connector-dev` run.

| File | Endpoint (on the account's regional teamapi host) | Inferred from |
|---|---|---|
| `account.json` | `GET /account/query` | `userStore.fetchUserAccount` (`userId`, `nickname`, `unit`, `sportDataSummary.count`) |
| `dashboard.json` | `GET /dashboard/query` | dashboard cards (`summaryInfo.rhr`, `.lthr`, `.fitnessMaxHr`) |
| `activities.json` | `GET /activity/query?size&pageNumber&startDay&endDay` (`data.dataList`, `count`, `totalPage`) | activity list table columns and sort keys |
| `day-detail.json` | `GET /analyse/dayDetail/query?startDay&endDay` (`data.dayList`) | data-analysis board (`happenDay`, `ati`, `cti`, `tiredRateNew`, `avgSleepHrv`, `sleepHrvIntervalList`, `staminaLevel`, `lthr`, `ltsp`) |
| `schedule.json` | `GET /training/schedule/query?startDate&endDate` | training calendar store (`entities`, `programs`, joined by `idInPlan` + `planId`) |

Units assumed (to verify live): activity `distance` in metres, `calorie` in calories (the list
divides by 1000 for kcal), `totalTime`/`workoutTime` in seconds, `startTime` in epoch seconds,
`startTimezone` in quarter hours, daily `ltsp` in seconds per kilometre, HRV in milliseconds.

## Live check, 2026-11-12

A signed-in `connector-dev` run against a canary US-region account (`CPL-coros-region=1`,
teamapi.coros.com) confirmed, with one FIT activity imported through Training Hub's Import data
and one Quick Training added to its calendar:

- `CPL-coros-token` and `CPL-coros-region` are readable from `document.cookie` (domain
  `.coros.com`, not HttpOnly); the app sends `accessToken` and `YFHeader: {"language":"en-US"}`.
- Envelope `{ result, message, data }` with `"0000"`; a missing or bad token answers HTTP 200 with
  `result: "1019"`, which the app meets with `POST /account/refresh` before sending the owner to
  `/login`.
- Activity units as assumed: `distance` metres, `calorie` calories (320000 for 320 kcal),
  `totalTime` seconds, `startTime` epoch seconds, `startTimezone` quarter hours (-32 for UTC-8).
  `trainingLoad` and `device` can be absent from a row. An empty window answers `{ count: 0 }`
  with no `dataList`; a page past `totalPage` answers without `dataList`.
- 28-day `dayDetail` and `schedule` windows are accepted. An empty calendar has no `entities` or
  `programs` keys; a planned entry not yet rated has `completeRate: "-1.00"`.

The files here stay synthetic.
