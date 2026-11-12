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
| `schedule.json` | `GET /training/schedule/query?startDate&endDate&supportRestExercise=1` | training calendar store (`entities`, `programs`, joined by `idInPlan` + `planId`) |

Units assumed (to verify live): activity `distance` in metres, `calorie` in calories (the list
divides by 1000 for kcal), `totalTime`/`workoutTime` in seconds, `startTime` in epoch seconds,
`startTimezone` in quarter hours, daily `ltsp` in seconds per kilometre, HRV in milliseconds.
