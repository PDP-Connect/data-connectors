// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import type { Page, Response } from "playwright";
import type { BrowserCollectContext } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { classifyAdsDialogInPage, collectAllStreams } from "./index.ts";
import { validateRecord } from "./schemas.ts";

function setup(streams: string[], followingPages: unknown[] = []) {
	const harness = makeRecordingEmit(validateRecord);
	const failures: string[] = [];
	const page: Partial<Page> = {
		url: () => "https://www.instagram.com/testuser/",
		goto: () => Promise.resolve(null),
		waitForResponse: () => Promise.reject(new Error("no response")),
		waitForFunction: () => Promise.reject(new Error("no control")),
		evaluate: ((fn: unknown, arg?: unknown) => {
			if (String(fn).includes("PolarisViewer")) {
				return Promise.resolve({ id: "u1", username: "testuser" });
			}
			if (arg && typeof arg === "object" && "path" in arg) {
				return Promise.resolve(followingPages.shift());
			}
			return Promise.resolve(false);
		}) as Page["evaluate"],
	};
	const ctx: BrowserCollectContext = {
		assist: async () => {
			throw new Error("unused assistance");
		},
		capture: null,
		completeAssistance: async () => undefined,
		context: {} as BrowserCollectContext["context"],
		credentials: {},
		detailGaps: [],
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		emittedAt: "2026-09-22T12:00:00.000Z",
		page: page as Page,
		progress: async () => undefined,
		reportStreamFailure: async (stream, message, options) => {
			assert.equal(options?.retryable, true);
			failures.push(stream);
			await harness.emit({
				type: "SKIP_RESULT",
				stream,
				reason: "stream_collection_failed",
				message,
				recovery_hint: { action: "retry_by_runtime", retryable: true },
			});
		},
		requestDetailGapPage: async () => [],
		requested: new Map(streams.map((name) => [name, { name }])),
		scope: { streams: [] },
		sendInteraction: async () => {
			throw new Error("unused interaction");
		},
		state: {},
	};
	return { ctx, failures, harness };
}

test("completion rule: unavailable posts and child likes report retryable stream failures", async () => {
	const { ctx, failures, harness } = setup(["posts", "post_likes"]);
	await collectAllStreams(ctx, async () => undefined);
	assert.deepEqual(failures, ["posts", "post_likes"]);
	assert.equal(
		harness.protocolMessages.some((message) => message.type === "STATE"),
		false,
	);
});

test("completion rule: a context without stream failure reporting cannot return success", async () => {
	const { ctx } = setup(["posts"]);
	delete ctx.reportStreamFailure;
	await assert.rejects(
		collectAllStreams(ctx, async () => undefined),
		(error: unknown) =>
			error instanceof Error &&
			"code" in error &&
			error.code === "stream_collection_failed",
	);
});

test("completion rule: missing ads controls report a retryable stream failure", async () => {
	const { ctx, failures, harness } = setup(["ads"]);
	await collectAllStreams(ctx, async () => undefined);
	assert.deepEqual(failures, ["ads"]);
	assert.equal(
		harness.protocolMessages.some((message) => message.type === "STATE"),
		false,
	);
});

test("completion rule: a page script error during ads scraping fails only the ads stream", async () => {
	const { ctx, failures, harness } = setup(["profile", "ads"]);
	const page = ctx.page as Partial<Page>;
	const baseEvaluate = page.evaluate as Page["evaluate"];
	page.waitForFunction = (() =>
		Promise.resolve(true)) as unknown as Page["waitForFunction"];
	page.evaluate = ((fn: unknown, arg?: unknown) => {
		if (String(fn).includes("PolarisViewer")) {
			return baseEvaluate(fn as never, arg as never);
		}
		return Promise.reject(
			new Error("page.evaluate: Execution context was destroyed"),
		);
	}) as Page["evaluate"];
	await collectAllStreams(ctx, async () => undefined);
	assert.deepEqual(failures, ["ads"]);
	assert.equal(
		harness.protocolMessages.some((message) => message.type === "STATE"),
		false,
	);
});

test("completion rule: ads classifier executes after browser serialization without host helpers", () => {
	const result = runInNewContext(
		`(${String(classifyAdsDialogInPage)})({ emptyMessage: "No advertisers" })`,
		{
			document: { querySelectorAll: () => [] },
		},
	);
	assert.equal(result.kind, "unavailable");
});

const failedFollowingPages = [
	{ label: "HTTP failure", page: { json: { users: [] }, status: 503 } },
	{ label: "missing payload", page: { json: null, status: 200 } },
	{
		label: "failure envelope",
		page: { json: { status: "fail", users: [] }, status: 200 },
	},
	{ label: "missing users", page: { json: {}, status: 200 } },
	{ label: "invalid users", page: { json: { users: [null] }, status: 200 } },
	{
		label: "invalid cursor",
		page: { json: { users: [], next_max_id: 42 }, status: 200 },
	},
	{
		label: "contradictory next page",
		page: { json: { users: [], has_more: true }, status: 200 },
	},
];

for (const { label, page } of failedFollowingPages) {
	test(`completion rule: following ${label} cannot complete as empty`, async () => {
		const { ctx, failures, harness } = setup(["following"], [page]);
		await collectAllStreams(ctx, async () => undefined);
		assert.deepEqual(failures, ["following"]);
		assert.equal(
			harness.protocolMessages.some((message) => message.type === "STATE"),
			false,
		);
	});
}

test("completion rule: a page evaluation error during following fails only following", async () => {
	const { ctx, failures, harness } = setup(["profile", "following"]);
	const page = ctx.page as Partial<Page>;
	const baseEvaluate = page.evaluate as Page["evaluate"];
	page.evaluate = ((fn: unknown, arg?: unknown) => {
		if (arg && typeof arg === "object" && "path" in arg) {
			return Promise.reject(
				new Error("page.evaluate: Execution context was destroyed"),
			);
		}
		return baseEvaluate(fn as never, arg as never);
	}) as Page["evaluate"];
	await collectAllStreams(ctx, async () => undefined);
	assert.deepEqual(failures, ["following"]);
	assert.deepEqual(
		harness.emitted.map((record) => record.stream),
		["profile"],
	);
	assert.equal(
		harness.protocolMessages.some((message) => message.type === "STATE"),
		false,
	);
});

test("completion rule: a page evaluation error on a later following page keeps the earlier users and fails following", async () => {
	const { ctx, failures, harness } = setup(
		["following"],
		[
			{
				json: { users: [{ id: "f1", username: "alice" }], next_max_id: "next" },
				status: 200,
			},
		],
	);
	const page = ctx.page as Partial<Page>;
	const baseEvaluate = page.evaluate as Page["evaluate"];
	let followingCalls = 0;
	page.evaluate = ((fn: unknown, arg?: unknown) => {
		if (arg && typeof arg === "object" && "path" in arg && followingCalls++ > 0) {
			return Promise.reject(
				new Error("page.evaluate: Execution context was destroyed"),
			);
		}
		return baseEvaluate(fn as never, arg as never);
	}) as Page["evaluate"];
	await collectAllStreams(ctx, async () => undefined);
	assert.deepEqual(failures, ["following"]);
	assert.deepEqual(
		harness.emitted.map((record) => `${record.stream}:${record.data.username}`),
		["following:alice"],
	);
});

test("completion rule: a non-meta error inside the posts walk fails posts and post_likes", async () => {
	const { ctx, failures, harness } = setup(["posts", "post_likes"]);
	const response: Partial<Response> = {
		json: async () => ({
			data: {
				xdt_api__v1__feed__user_timeline_graphql_connection: {
					edges: [],
					page_info: { has_next_page: true },
				},
			},
		}),
		status: () => 200,
	};
	ctx.page.waitForResponse = (() =>
		Promise.resolve(response as Response)) as Page["waitForResponse"];
	// The walk paces itself with `delay` after each non-terminal page; any
	// error raised there is not a meta_posts_* proof failure.
	await collectAllStreams(ctx, async () => {
		throw new Error("page.evaluate: Execution context was destroyed");
	});
	assert.deepEqual(failures, ["posts", "post_likes"]);
	assert.equal(
		harness.protocolMessages.some((message) => message.type === "STATE"),
		false,
	);
});

test("completion rule: explicit empty following payload completes without a failure", async () => {
	const { ctx, failures, harness } = setup(
		["following"],
		[{ json: { users: [], next_max_id: null, status: "ok" }, status: 200 }],
	);
	await collectAllStreams(ctx, async () => undefined);
	assert.deepEqual(failures, []);
	assert.deepEqual(harness.emitted, []);
	assert.equal(
		harness.protocolMessages.some((message) => message.type === "SKIP_RESULT"),
		false,
	);
});

test("completion rule: following without a terminal second page fails, keeps its first page, while profile completes", async () => {
	const { ctx, failures, harness } = setup(
		["profile", "following"],
		[
			{
				json: { users: [{ id: "f1", username: "alice" }], next_max_id: "next" },
				status: 200,
			},
			{ json: null, status: 0 },
		],
	);
	await collectAllStreams(ctx, async () => undefined);
	assert.deepEqual(failures, ["following"]);
	assert.deepEqual(
		harness.emitted.map((record) => record.stream),
		["profile", "following"],
	);
});

function nonterminalPostsResponse(edges: unknown[]): Response {
	return {
		json: async () => ({
			data: {
				xdt_api__v1__feed__user_timeline_graphql_connection: {
					edges,
					page_info: { has_next_page: true },
				},
			},
		}),
		status: () => 200,
	} as unknown as Response;
}

test("completion rule: a capped posts walk reports both requested streams as failed", async () => {
	const { ctx, failures, harness } = setup(["posts", "post_likes"]);
	ctx.page.waitForResponse = (() =>
		Promise.resolve(
			nonterminalPostsResponse([]),
		)) as Page["waitForResponse"];
	await collectAllStreams(ctx, async () => undefined);
	assert.deepEqual(failures, ["posts", "post_likes"]);
	assert.deepEqual(
		harness.protocolMessages
			.filter((message) => message.type === "SKIP_RESULT")
			.map((message) => `${message.stream}:${message.reason}`)
			.sort(),
		["post_likes:stream_collection_failed", "posts:stream_collection_failed"],
	);
	assert.equal(
		harness.protocolMessages.some((message) => message.type === "STATE"),
		false,
	);
});

test("completion rule: a capped posts walk keeps emitted records and fails only requested streams", async () => {
	const { ctx, failures, harness } = setup(["posts"]);
	ctx.page.waitForResponse = (() =>
		Promise.resolve(
			nonterminalPostsResponse([
				{ node: { id: "p1", taken_at: 1_700_000_000 } },
			]),
		)) as Page["waitForResponse"];
	await collectAllStreams(ctx, async () => undefined);
	assert.deepEqual(failures, ["posts"]);
	assert.deepEqual(
		harness.emitted.map((record) => record.stream),
		["posts"],
	);
	assert.equal(
		harness.protocolMessages.some((message) => message.type === "STATE"),
		false,
	);
});

test("completion rule: a capped following walk keeps its users and reports following failed", async () => {
	const pages: unknown[] = [];
	for (let index = 0; index < 500; index += 1) {
		pages.push({
			json: {
				users: [{ id: `f${index}`, username: `user${index}` }],
				next_max_id: `cursor${index}`,
			},
			status: 200,
		});
	}
	const { ctx, failures, harness } = setup(["following"], pages);
	await collectAllStreams(ctx, async () => undefined);
	assert.deepEqual(failures, ["following"]);
	assert.ok(
		harness.emitted.filter((record) => record.stream === "following").length >
			1,
	);
	assert.deepEqual(
		harness.protocolMessages
			.filter((message) => message.type === "SKIP_RESULT")
			.map((message) => message.reason),
		["stream_collection_failed"],
	);
	assert.equal(
		harness.protocolMessages.some((message) => message.type === "STATE"),
		false,
	);
});
