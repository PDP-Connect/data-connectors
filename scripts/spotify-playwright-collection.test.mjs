// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// spotify-playwright: the spotify.profile record must count as one record on
// hosts that count a scope's records as the length of the first array in its
// payload. The mobile PS-Lite writer does this (stagedRecordCount in
// unity-surfaces apps/mobile-shell/ps_bundle/src/harness.js), so a profile
// with `images: []` (no avatar) counted as zero records and was skipped, and
// a run whose library was also empty failed with no_data.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import vm from "node:vm";

import { readTarGzEntries } from "../packages/connector-installer-core/tar-stream.mjs";

const root = join(dirname(new URL(import.meta.url).pathname), "..");
const artifactsDir = join(root, "artifacts/spotify-playwright");
const semver = (v) => v.split(".").map(Number);
const byVersion = (a, b) => { const [x, y] = [a, b].map(semver); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };

// The newest committed spotify-playwright source directory, so a new version
// is covered the moment its directory lands beside the tarball.
const SPOTIFY_VERSION = readdirSync(artifactsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^spotify-playwright-\d+\.\d+\.\d+$/.test(entry.name))
  .map((entry) => entry.name.replace("spotify-playwright-", ""))
  .sort(byVersion)
  .at(-1);
const sourceDir = join(artifactsDir, `spotify-playwright-${SPOTIFY_VERSION}`);
const script = readFileSync(join(sourceDir, "script.js"), "utf8");
const profileSchema = JSON.parse(readFileSync(join(sourceDir, "schemas/spotify.profile.json"), "utf8")).schema;

// PS-Lite's stagedRecordCount, verbatim.
function stagedRecordCount(payload) {
  if (Array.isArray(payload)) return payload.length;
  if (payload && typeof payload === "object") {
    const arrayKey = Object.keys(payload).find((key) => Array.isArray(payload[key]));
    return arrayKey ? payload[arrayKey].length : Object.keys(payload).length;
  }
  return payload === null || payload === undefined ? 0 : 1;
}

const slice = (source, start, end) => {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt);
  assert.notEqual(startAt, -1, `missing source starting with ${start}`);
  assert.notEqual(endAt, -1, `missing source ending with ${end}`);
  return source.slice(startAt, endAt);
};

// Runs the script's profile step (GraphQL identity + spclient enrichment)
// against scripted responses and returns state.profile.
const buildProfile = async (source, { imageUrl = null, spclientImage = null } = {}) => {
  const body = slice(source, "const profileAttrs = await gqlFetch(", "// Step 2: Liked Songs");
  const context = vm.createContext({
    state: { profile: null },
    page: { setData: async () => {} },
    gqlFetch: async () => ({
      data: { me: { profile: { username: "user123", name: "Test User", uri: "spotify:user:user123", imageUrl } } },
    }),
    spClientFetch: async () => ({
      uri: "spotify:user:user123",
      followers_count: 3,
      following_count: 4,
      image_url: spclientImage,
    }),
  });
  await vm.runInContext(`(async () => {\n${body}\n})()`, context, { filename: "spotify-playwright-profile.js" });
  // Round-trip through JSON: the host receives the result serialized.
  return JSON.parse(JSON.stringify(context.state.profile));
};

const assertMatchesSchema = (profile) => {
  for (const key of profileSchema.required) assert.ok(key in profile, `profile must carry ${key}`);
  for (const key of Object.keys(profile)) {
    assert.ok(key in profileSchema.properties, `profile key ${key} is not in spotify.profile's schema`);
  }
  if ("images" in profile) {
    assert.ok(Array.isArray(profile.images) && profile.images.every((url) => typeof url === "string"));
  }
};

test(`spotify-playwright@${SPOTIFY_VERSION}: a profile without an avatar counts as a record`, async () => {
  const profile = await buildProfile(script);
  assert.equal(profile.id, "user123");
  assert.equal(profile.display_name, "Test User");
  assert.ok(!("images" in profile), "an empty images array must be omitted");
  assert.ok(stagedRecordCount(profile) >= 1, `stagedRecordCount must be >= 1, got ${stagedRecordCount(profile)}`);
  assertMatchesSchema(profile);
});

test(`spotify-playwright@${SPOTIFY_VERSION}: a profile with an avatar keeps images and counts as one record`, async () => {
  const graphql = await buildProfile(script, { imageUrl: "https://i.scdn.co/image/a" });
  assert.deepEqual(graphql.images, ["https://i.scdn.co/image/a"]);
  assert.equal(stagedRecordCount(graphql), 1);
  assertMatchesSchema(graphql);

  const enriched = await buildProfile(script, { spclientImage: "https://i.scdn.co/image/b" });
  assert.deepEqual(enriched.images, ["https://i.scdn.co/image/b"]);
  assert.equal(stagedRecordCount(enriched), 1);
});

test("spotify-playwright@1.1.2 (the previous script) counts a profile without an avatar as zero records", async () => {
  const entries = await readTarGzEntries(readFileSync(join(artifactsDir, "spotify-playwright-1.1.2.tgz")), {
    maxUnpackedBytes: 16 * 1024 * 1024,
  });
  const previous = entries.find((entry) => entry.path.replace(/^\.\//, "") === "script.js");
  assert.ok(previous, "1.1.2 tarball must contain script.js");
  const profile = await buildProfile(previous.buffer.toString("utf8"));
  assert.deepEqual(profile.images, []);
  assert.equal(stagedRecordCount(profile), 0);
});

test(`spotify-playwright@${SPOTIFY_VERSION}: the profile is emitted unwrapped under spotify.profile`, () => {
  assert.match(script, /'spotify\.profile': state\.profile,/);
});
