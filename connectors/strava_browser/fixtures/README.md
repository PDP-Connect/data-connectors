# Strava browser fixtures

Synthetic. No real athlete, activity or gear data.

- `training-activities-page-*.json`: `GET https://www.strava.com/athlete/training_activities`
  with `X-Requested-With: XMLHttpRequest`. The envelope, the key set of each
  model and each value's JSON type match what strava.com served the PDPP test
  account on 2026-09-28; every value is invented. Pages hold three models so
  that two pages exercise pagination (strava.com answers `per_page=20` with
  up to twenty). One start falls on different calendar days in UTC and in
  local time, which `start_date` must get right.
- `login.html`: a sign-in form, the page a signed-out browser is sent to.

Signed out, the same list URL answers HTTP 401 with a JSON body; the tests
and the PageShim fixture serve that.
