// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

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
