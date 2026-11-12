// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The runtime keys a record by `String(data.id)` unless the connector names
 * its key fields, and a Personal Server rejects a record whose key disagrees
 * with the manifest `primary_key`. Every stream whose primary key is not `id`
 * alone must be declared.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { META_RECORD_KEY_FIELDS } from "./index.ts";

const manifest = JSON.parse(
	readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
) as { streams: { name: string; primary_key: string[] }[] };

test("the runtime key fields are the manifest primary keys that are not id alone", () => {
	const expected = Object.fromEntries(
		manifest.streams
			.filter((stream) => stream.primary_key.join() !== "id")
			.map((stream) => [stream.name, stream.primary_key]),
	);
	assert.deepEqual(META_RECORD_KEY_FIELDS, expected);
});
