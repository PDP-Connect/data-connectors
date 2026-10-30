// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolveOptionsSchemaFromManifest } from "../../packages/polyfill-connectors/src/connector-options-schema.ts";

const manifest = JSON.parse(
	readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
);
const reclaimUploads = manifest.options_schema.properties.RECLAIM_UPLOADS;

// `reclaimUploads` in index.ts removes the archive's `__uploads/` directory
// after a durable commit. PDPP keeps no copy and the export does not download
// the files again; archive-reclaim.test.ts pins the removal. The text an owner
// reads before turning the option on has to say so, and it stays off by default.
test("the RECLAIM_UPLOADS option is off by default and says it deletes files for good", () => {
	assert.equal(reclaimUploads.default, false);
	assert.match(reclaimUploads.description, /\bdelete/i);
	assert.match(reclaimUploads.description, /no other copy/i);
	assert.match(reclaimUploads.description, /cannot be recovered/i);
	assert.doesNotMatch(
		reclaimUploads.description,
		/previously-failed|on retry/i,
	);
});

// The option reader (packages/polyfill-connectors/src/connector-options-schema.ts)
// is not a JSON Schema implementation. For an array option it takes the allowed
// element values from a property-level `enum`, and the host publishes them as
// the option's `enum` for the form, so the manifest declares them there. It
// does not check a stored value against them.
test("CHANNEL_TYPES declares its allowed element values where the option reader takes them", () => {
	const resolved = resolveOptionsSchemaFromManifest(manifest, "slack.json");
	assert.ok(resolved);
	const option = resolved.options.find(
		(entry) => entry.optionKey === "CHANNEL_TYPES",
	);
	assert.ok(option);
	assert.equal(option.type, "string_array");
	assert.deepEqual(option.enumValues, ["public", "private", "im", "mpim"]);
	const allowed = new Set(option.enumValues);
	assert.ok(Array.isArray(option.defaultValue));
	for (const value of option.defaultValue as readonly string[]) {
		assert.ok(allowed.has(value), `${value} is an allowed channel type`);
	}
});
