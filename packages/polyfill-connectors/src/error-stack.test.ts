// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { packageRoot as PACKAGE_ROOT } from "./connector-paths.ts";
import { ERROR_STACK_MAX_FRAMES, errorStackFrames } from "./error-stack.ts";
import { runConnectorProtocolSubprocess } from "./test-harness.ts";

const withStack = (stack: unknown): Error => {
	const error = new Error("unused");
	Object.defineProperty(error, "stack", { value: stack });
	return error;
};

test("keeps root-relative frames and never the message", () => {
	const frames = errorStackFrames(
		withStack(
			[
				"TypeError: jane.doe@example.com has no token sk-live-9f8e7d6c5b4a39281706",
				"    at collect (file:///Users/jane.doe/Library/Application%20Support/org.vana.desktop/pdpp/collection-profiles/strava/dist/collection-profile.mjs:412:9)",
				"    at eval (vana-connector/strava-browser.js:7:48213)",
				"    at run (C:\\Users\\Jane Doe\\src\\data-connectors\\packages\\polyfill-connectors\\src\\connector-runtime.ts:120:11)",
			].join("\n"),
		),
	);
	assert.equal(
		frames,
		[
			"    at collection-profiles/strava/dist/collection-profile.mjs:412:9",
			"    at vana-connector/strava-browser.js:7:48213",
			"    at packages/polyfill-connectors/src/connector-runtime.ts:120:11",
		].join("\n"),
	);
	assert.doesNotMatch(frames ?? "", /jane|Jane|sk-live|Users|TypeError/u);
});

test("drops site scripts, extensions, node internals, node_modules and eval", () => {
	const frames = errorStackFrames(
		withStack(
			[
				"Error: Unexpected token < in JSON",
				"    at JSON.parse (<anonymous>)",
				"    at https://www.instagram.com/static/bundles/abc.js:1:2345",
				"    at chrome-extension://abcdefghijklmnop/content.js:5:6",
				"    at node:internal/process/task_queues:95:5",
				"    at Object.<anonymous> (/Users/jane/vana/node_modules/playwright-core/lib/server/page.js:10:2)",
				"    at eval (eval at <anonymous> (https://runner.local/:2:10), <anonymous>:3:7)",
				"    at /Users/jane/notes/connectors.txt:1:1",
			].join("\n"),
		),
	);
	assert.equal(frames, undefined);
});

test("reads WebKit frames but not an email in the message", () => {
	assert.equal(
		errorStackFrames(
			withStack(
				[
					"login failed for jane@example.com:443",
					"collect@vana-connector/chatgpt.js:4:1200",
					"global code@https://runner.local/:1:1",
				].join("\n"),
			),
		),
		"    at vana-connector/chatgpt.js:4:1200",
	);
});

test("drops a query string and a path that climbs out of its root", () => {
	assert.equal(
		errorStackFrames(
			withStack(
				"Error\n    at x (/srv/connectors/strava/index.ts?token=abc:5:6)\n    at y (/srv/connectors/../etc/passwd.js:1:1)",
			),
		),
		"    at connectors/strava/index.ts:5:6",
	);
});

test("is bounded and tolerates anything that is not an error", () => {
	const many = Array.from(
		{ length: 40 },
		(_, i) => `    at f (/x/connectors/a/b.ts:${String(i + 1)}:1)`,
	).join("\n");
	assert.equal(
		errorStackFrames(withStack(`Error\n${many}`))?.split("\n").length,
		ERROR_STACK_MAX_FRAMES,
	);
	for (const value of [undefined, null, 7, "Error: x", {}, withStack(5)]) {
		assert.equal(errorStackFrames(value), undefined);
	}
});

test("a failed DONE carries the thrown error's frames, root-relative", async () => {
	const result = await runConnectorProtocolSubprocess({
		allowFailedDone: true,
		cwd: PACKAGE_ROOT,
		entrypoint: join(
			PACKAGE_ROOT,
			"src",
			"test-fixtures",
			"observation-hidden-element-fixture.ts",
		),
		env: { FIXTURE_DECLARE_OBSERVATION: "0" },
		start: { type: "START", scope: { streams: [{ name: "items" }] } },
	});
	const done = result.messages.findLast((m) => m.type === "DONE");
	assert.equal(done?.type, "DONE");
	const stack = Reflect.get(
		Object(Reflect.get(Object(done?.error), "diagnostics")),
		"stack_frames",
	);
	assert.equal(typeof stack, "string");
	for (const line of String(stack).split("\n")) {
		assert.match(
			line,
			/^ {4}at (?:vana-connector|collection-profiles|connectors|packages\/polyfill-connectors)\/[^\s]+:\d+(?::\d+)?$/u,
		);
	}
	assert.match(
		String(stack),
		/packages\/polyfill-connectors\/src\/test-fixtures\/observation-hidden-element-fixture\.ts:\d+/u,
	);
	// Nothing of the checkout's absolute location survives.
	const checkout = PACKAGE_ROOT.slice(
		0,
		PACKAGE_ROOT.lastIndexOf("/packages/"),
	);
	assert.equal(String(stack).includes(checkout), false);
});
