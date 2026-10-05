# garmin_browser fixtures

Synthetic. No real Garmin data.

The envelopes, the key names and each value's JSON type follow what connect.garmin.com served a
signed-in browser page on 3 October 2026 for every endpoint below except HRV; every value is
invented. Most keys the connector never reads are trimmed. Kept on purpose, unread: the handle
(`displayName`, `ownerDisplayName`), account and device ids, names, coordinates and places, the
`local*` sleep times, and near-miss keys a parser must be seen to ignore:

- `activities.json`: `activityUUID`, `duration`, `beginTimestamp`, `averageSpeed`, and the
  type's `typeId` and `parentTypeId`.
- `training-status.json`: `sinceDate`, `sport`, `subSport`, `loadTunnelMin`, `loadTunnelMax`,
  `loadLevelTrend`, `fitnessTrend`, `fitnessTrendSport`, `acuteTrainingLoadDTO`, `showSelector`
  and `lastPrimarySyncDate` (the last two in `training-status-empty.json` too).
- `hrv-daily.json`: `lastNight5MinHigh`, `baseline`, `feedbackPhrase` and `createTimeStamp`.
- `daily-summary.json` and `daily-summary-empty.json`: `lastSevenDaysAvgRestingHeartRate`.

Garmin leaves a key out rather than send null, so a missing metric is as real as a null one (the
first night in `sleep-stats.json` has no `spO2`).

| File | Endpoint (all `GET`, with the page's `connect-csrf-token` header) |
|---|---|
| `settings.json` | `/gc-api/userprofile-service/userprofile/settings` |
| `daily-summary.json`, `daily-summary-empty.json` | `/gc-api/usersummary-service/usersummary/daily?calendarDate=…` |
| `sleep-stats.json`, `sleep-stats-empty.json` | `/gc-api/sleep-service/stats/sleep/daily/{from}/{to}` (`overallStats` is not read and left empty) |
| `hrv-daily.json` | `/gc-api/hrv-service/hrv/daily/{from}/{to}` |
| `training-status.json`, `training-status-empty.json` | `/gc-api/metrics-service/metrics/trainingstatus/daily/{day}` |
| `activities.json` | `/gc-api/activitylist-service/activities/search/activities?startDate=…&endDate=…&start=…&limit=100` |

The owner's account never recorded HRV Status, so its HRV window always answered 204 and the shape
of `hrv-daily.json` was not observed on a live account. It follows the recorded responses in
garth's test cassettes (`matin/garth`, `tests/stats/cassettes/test_daily_hrv.yaml`,
`test_daily_hrv_paginate.yaml`, `test_daily_hrv_no_results.yaml`) and go-garmin's
(`llehouerou/go-garmin`, `testdata/cassettes/hrv.yaml`), recorded in August 2023 and January 2026,
and the browser path that reads the same body with the same header
(`estruyf/garmin-workout-browser-extension`, `src/lib/garmin-api.ts`). It holds an onboarding night
(status `NONE`, no baseline, no weekly average), a `BALANCED` night with a baseline, and a night
with no overnight reading whose status and weekly average carry forward.

The account's time zone is `Pacific/Auckland`, so the fixture dates fall on different calendar
days in UTC and in the owner's zone: the first night starts on 14 September in UTC and on
15 September locally, and the ride starts on 15 September in UTC and on 16 September locally.

`../fake-garmin.ts` serves these files as the live site answers: one day per daily read, each range
read cut to the rows inside it, 204 for an HRV window with no nights, activities filtered by local
start day and paged.
