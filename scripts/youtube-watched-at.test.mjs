import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The connector runs as a single self-contained script inside the desktop
// runner's AsyncFunction sandbox, so the resolver cannot live in an importable
// module. Test the exact shipped code by extracting the marked region.
const connectorPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "connectors",
  "google",
  "youtube-playwright.js"
);
const source = readFileSync(connectorPath, "utf8");
const match = source.match(
  /\/\* WATCHED_AT_RESOLVER:BEGIN \*\/([\s\S]*?)\/\* WATCHED_AT_RESOLVER:END \*\//
);
assert.ok(match, "WATCHED_AT_RESOLVER markers not found in youtube-playwright.js");

const resolveWatchedAt = new Function(`${match[1]}; return resolveWatchedAt;`)();

// Fixed scrape moment: Saturday 2026-07-18 (local time of the test runner).
const NOW = new Date(2026, 6, 18, 15, 30, 0);

test("Today resolves to the scrape date", () => {
  assert.equal(resolveWatchedAt("Today", NOW), "2026-07-18");
});

test("Yesterday resolves to the day before the scrape date", () => {
  assert.equal(resolveWatchedAt("Yesterday", NOW), "2026-07-17");
});

test("weekday headers resolve to the most recent past weekday", () => {
  // NOW is a Saturday; Monday of that week is 2026-07-13.
  assert.equal(resolveWatchedAt("Monday", NOW), "2026-07-13");
  assert.equal(resolveWatchedAt("Friday", NOW), "2026-07-17");
  // Same weekday as "now" means a week ago, never today.
  assert.equal(resolveWatchedAt("Saturday", NOW), "2026-07-11");
});

test("absolute header with a year parses as-is", () => {
  assert.equal(resolveWatchedAt("Jan 23, 2026", NOW), "2026-01-23");
});

test("absolute header without a year assumes the current year", () => {
  assert.equal(resolveWatchedAt("Jul 15", NOW), "2026-07-15");
});

test("year-less header in the future rolls back to last year", () => {
  assert.equal(resolveWatchedAt("Dec 31", NOW), "2025-12-31");
});

test("missing or unrecognized header text yields null", () => {
  assert.equal(resolveWatchedAt(null, NOW), null);
  assert.equal(resolveWatchedAt("", NOW), null);
  assert.equal(resolveWatchedAt("   ", NOW), null);
  assert.equal(resolveWatchedAt("garbage header", NOW), null);
});

test("small fixture watchedAt values are consistent with their headers", () => {
  const fixture = JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "connectors",
        "google",
        "fixtures",
        "youtube.history.small.json"
      ),
      "utf8"
    )
  );
  // The fixture is a static snapshot anchored to a nominal 2026-07-18 scrape.
  const anchor = new Date(2026, 6, 18, 12, 0, 0);
  for (const item of fixture.history) {
    assert.equal(
      item.watchedAt,
      resolveWatchedAt(item.watchedAtText, anchor),
      `fixture item ${item.videoId} watchedAt mismatch for header ${item.watchedAtText}`
    );
  }
});
