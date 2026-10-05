#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Fitbit connector (v0.1.0): file-based.
 *
 * Auth: none. This reads the Fitbit data an owner exports with Google
 * Takeout (takeout.google.com, selecting the Fitbit product, which may be
 * listed as Google Health), as the ZIP file or files Takeout produces. When
 * the import folder holds several exports, only the newest is read. It needs
 * no developer program and no Google credential, and nothing here makes a
 * network request.
 *
 * DO NOT AUTOMATE THE REQUEST OR THE DOWNLOAD. `manual_or_upload` is
 * load-bearing. Google's Terms of Service (https://policies.google.com/terms,
 * effective 30 July 2026) forbid "using automated means to access content
 * from any of our services in violation of the machine-readable instructions
 * on our web pages (for example, robots.txt files that disallow crawling,
 * training, or other activities)", and https://takeout.google.com/robots.txt
 * disallows every path under `/u/` and every path containing `/_/`, which
 * is where Takeout works. Takeout is the route Google provides;
 * driving it, or fetching the export on the owner's behalf, is not. The
 * owner's manual step is the compliance boundary.
 *
 * CONFORMANCE EXEMPTIONS. There is no network surface, so this connector is
 * permanently exempt from the reachability probe, and mock-mutation reports
 * UNKNOWN for it by design (CONNECTOR-CHECKLIST.md, exemption rule).
 *
 * Streams, each read from the legacy files in the export's
 * `Global Export Data/` folder:
 *   - activities            one record per exercise log (exercise-<N>.json)
 *   - daily_summaries       one record per local day with a reading
 *                           (steps-, distance-, lightly_active_minutes-,
 *                           moderately_active_minutes-, very_active_minutes-
 *                           and resting_heart_rate-<date>.json, plus the one
 *                           `timezone` cell of Your Profile/Profile.csv)
 *   - sleep                 one record per sleep log, naps included
 *                           (sleep-<date>.json, joined with the overall score
 *                           in Sleep Score/sleep_score.csv)
 * The Google-era `*_GoogleData` CSV folders are never read; they are only
 * noticed, to tell a changed layout from an upload that is not a Fitbit
 * export.
 *
 * COVERAGE. Each requested stream ends with one plain-words PROGRESS line
 * carrying the records delivered as `count`, and one `coverage` diagnostic
 * on stderr saying what it covered and why it stops there: status, reason,
 * records delivered, the fields the export never carried or could not be
 * read, and the requested and covered windows (collect.ts). A stream that
 * skipped anything also gets a SKIP_RESULT with a recovery hint.
 *
 * REPEAT IMPORTS. There is no cursor and never a STATE message. Every export
 * is a full-history snapshot of data Fitbit recomputes and owners edit, so
 * every import re-reads the whole of it. Ids are stable (Fitbit's log ids, or
 * the date), so a later export replaces an earlier one record for record.
 *
 * TIME WINDOWS. A requested window is applied to `start_time` for
 * activities, a UTC instant, and to `date` for the daily streams, Fitbit's
 * local calendar day; the runtime compares both by their first ten
 * characters, and this connector compares an activity's start to each bound
 * as an instant. The coverage line counts only the records both keep,
 * and an unreadable row counts against it only when it could fall inside the
 * requested window. A changed layout and `fields_unavailable` are judged over
 * the whole export, inside the window or not. The runtime's time gate and
 * this connector's own reading of the window must agree, by the date rule or
 * the exact-instant rule, wherever no resource filter explains a difference:
 * if they ever do not, the coverage line would
 * describe a window the reader did not get, so the run fails with
 * `time_range_semantics_changed` rather than carry on silently.
 *
 * THE LOCAL DAY. Steps and distance are exported as UTC minutes. Each minute
 * is placed on its local day in the profile's time zone, which is read, used
 * and dropped: it never leaves the clock that places the minutes. With no
 * usable zone, steps and distance are blank and named unreadable on every
 * day, rather than placed on a guessed day. A daily file that was not read in
 * full never gives a day's figure: on the days it placed rows on, and the
 * days its name places it over (from the day before its file-name date
 * through the next file's date), steps and distance are blank and named
 * unreadable, and a one-row field keeps the row read for that day or is
 * named unreadable where none was. Those records replace the ones an earlier
 * import stored for the same days; every other day keeps its values. The
 * daily files are padded past the export date, so a day more than one day
 * past the export's UTC date is a record only with a readable non-zero value.
 *
 * NAMES AND VALUES STAY HERE. No record, SKIP_RESULT, PROGRESS message or
 * error names a member, the upload, the import folder, a scratch file, the
 * time zone or any record value: messages are constant per reason, progress
 * names the stream, a family's fixed key, fixed reason and status tokens and
 * schema field names and gives counts and dates, and an error is reported by
 * its code alone.
 *
 * EXCLUDED. Location and its proxies (GPS files, route links, the profile's
 * place and time zone, every local time of day), identity (every other
 * profile cell, devices, the exercise's device source), free text (exercise
 * names the owner typed, the about-me text, journals), audit clocks, and
 * every reading out of scope (calories, floors, sedentary minutes, heart
 * rate through the day, HRV, SpO2, temperature, stress, readiness, VO2 max,
 * weight) are absent from every schema (schemas.ts). Absence from the schema
 * is the enforcement.
 */

import { runConnector } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { collectFitbit, timeRangeField } from "./collect.ts";
import { validateRecord } from "./schemas.ts";

runConnector({
	name: "fitbit",
	validateRecord,
	timeRangeField,
	collect: collectFitbit,
});
