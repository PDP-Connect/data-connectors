// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { packageRoot } from "../../packages/polyfill-connectors/src/connector-paths.ts";
import { runConnectorProtocolSubprocess } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { ensureYoutubeSession, youtubeConnectorConfig } from "./index.ts";

function handoffFixture() {
	let signedIn = false;
	const navigations: string[] = [];
	const completions: string[] = [];
	const sibling = {
		url: "about:blank",
		async waitForFunction() {
			return {
				jsonValue: async () => "content",
				dispose: async () => undefined,
			};
		},
		async goto(url: string) {
			this.url = url;
			navigations.push(`sibling:${url}`);
		},
		async evaluate() {
			return this.url === "https://www.youtube.com/" && signedIn;
		},
		async close() {
			/* readiness page closes after the probe */
		},
	};
	const owner = {
		url: "about:blank",
		async waitForFunction() {
			return {
				jsonValue: async () => "content",
				dispose: async () => undefined,
			};
		},
		async goto(url: string) {
			this.url = url;
			navigations.push(`owner:${url}`);
		},
		async evaluate() {
			return this.url === "https://www.youtube.com/" && signedIn;
		},
		context() {
			return { newPage: async () => sibling };
		},
	};
	const args = {
		page: owner,
		assist: async () => {
			signedIn = true;
			return "assist_1";
		},
		completeAssistance: async (_id: string, status: string) => {
			completions.push(status);
		},
		sendInteraction: async () => {
			throw new Error("streamed handoff must not wait for Continue");
		},
	};
	return {
		args,
		completions,
		navigations,
		setSignedIn: (value: boolean) => {
			signedIn = value;
		},
	};
}

test("production session hook navigates the blank sibling and resolves streamed sign-in", async () => {
	const fixture = handoffFixture();
	assert.equal(youtubeConnectorConfig.ensureSession, ensureYoutubeSession);
	await ensureYoutubeSession(fixture.args as never);
	assert.deepEqual(fixture.navigations, [
		"owner:https://www.youtube.com/",
		"sibling:https://www.youtube.com/",
	]);
	assert.deepEqual(fixture.completions, ["resolved"]);
});

test("production session hook escalates a timed-out streamed handoff", async () => {
	const fixture = handoffFixture();
	fixture.args.assist = async () => {
		fixture.setSignedIn(false);
		return "assist_1";
	};
	await assert.rejects(
		ensureYoutubeSession(fixture.args as never, 0),
		/browser_handoff_readiness_timed_out/,
	);
	assert.deepEqual(fixture.completions, ["escalated"]);
	assert.ok(fixture.navigations.includes("sibling:https://www.youtube.com/"));
});

test("runConnector emits streamed assistance completion and DONE through the production session hook", async () => {
	const entrypoint = fileURLToPath(
		new URL("./__fixtures__/session-protocol.ts", import.meta.url),
	);
	const start = {
		type: "START" as const,
		scope: { streams: [{ name: "profile" }] },
	};
	const success = await runConnectorProtocolSubprocess({
		cwd: packageRoot,
		entrypoint,
		start,
	});
	assert.deepEqual(
		success.messages
			.filter((message) =>
				["ASSISTANCE", "ASSISTANCE_STATUS", "DONE"].includes(message.type),
			)
			.map((message) => message.type),
		["ASSISTANCE", "ASSISTANCE_STATUS", "DONE"],
	);
	assert.equal(
		success.messages.find((message) => message.type === "ASSISTANCE_STATUS")
			?.status,
		"resolved",
	);
	assert.equal(
		success.messages.find((message) => message.type === "DONE")?.status,
		"succeeded",
	);
	const timeout = await runConnectorProtocolSubprocess({
		cwd: packageRoot,
		entrypoint,
		start,
		env: { YOUTUBE_FIXTURE_TIMEOUT: "1" },
		allowFailedDone: true,
	});
	assert.deepEqual(
		timeout.messages
			.filter((message) =>
				["ASSISTANCE", "ASSISTANCE_STATUS", "DONE"].includes(message.type),
			)
			.map((message) => message.type),
		["ASSISTANCE", "ASSISTANCE_STATUS", "DONE"],
	);
	assert.equal(
		timeout.messages.find((message) => message.type === "ASSISTANCE_STATUS")
			?.status,
		"escalated",
	);
	assert.equal(
		timeout.messages.find((message) => message.type === "DONE")?.status,
		"failed",
	);
});
