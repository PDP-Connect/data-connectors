import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

test("a fractional conversation cap never turns a nonempty incremental batch into an empty one", () => {
	const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	const env = { PDPP_ANTHROPIC_LIVE_MAX_CONVERSATIONS_PER_RUN: "0.5" };
	const begin = source.indexOf("const positiveEnv =");
	const end = source.indexOf(
		"// Read per call",
		source.indexOf("const maxConversationsPerRun ="),
	);
	const read = runInNewContext(
		stripTypeScriptTypes(source.slice(begin, end)) + "\nmaxConversationsPerRun",
		{ process: { env } },
	);
	assert.deepEqual(["changed"].slice(0, read()), ["changed"]);
	env.PDPP_ANTHROPIC_LIVE_MAX_CONVERSATIONS_PER_RUN = "2";
	assert.equal(read(), 2);
});
