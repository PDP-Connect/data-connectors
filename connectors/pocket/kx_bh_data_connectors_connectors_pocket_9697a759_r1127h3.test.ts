import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

test("an out-of-range Pocket time becomes absent instead of throwing in item projection", () => {
	const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	const chunk = source.slice(
		source.indexOf("const isoFromUnix"),
		source.indexOf("async function fetchPocketPage"),
	);
	const itemRecord = runInNewContext(
		stripTypeScriptTypes(chunk) + "\nitemRecord",
	);
	const out = itemRecord({
		item_id: "1",
		time_added: "8640000000001",
		time_updated: "1700000000",
		status: "0",
	});
	assert.equal(out.time_added, null);
	assert.equal(out.time_updated, "2023-11-14T22:13:20.000Z");
});
