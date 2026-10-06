// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// `issues` and `gists` declare `created_at` as their consent_time_field, so a
// `time_range.until` keeps an item created before it even when the item was
// updated afterwards. Every GitHub cursor must stay strictly below `until`, so
// a later run still reads the items this run skipped.

import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { StreamScope } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	collectEvents,
	collectGists,
	collectIssues,
	collectRepositories,
	collectStarred,
	createGithubHttpGovernor,
	type StreamCtx,
} from "./index.ts";

const UNTIL = "2026-06-05T00:00:00Z";

function makeCtx(stream: string): {
	ctx: StreamCtx;
	ids: () => unknown[];
	cursor: () => unknown;
} {
	const records: Array<{ stream: string; data: Record<string, unknown> }> = [];
	const states: unknown[] = [];
	const requested = new Map<string, StreamScope>([
		[stream, { name: stream, time_range: { until: UNTIL } }],
	]);
	const ctx = {
		emit: (msg: { type: string; cursor?: unknown }) => {
			if (msg.type === "STATE") states.push(msg.cursor);
			return Promise.resolve();
		},
		emitRecord: (s: string, data: Record<string, unknown>) => {
			records.push({ stream: s, data });
			return Promise.resolve();
		},
		httpGovernor: createGithubHttpGovernor({ retrySleep: () => undefined }),
		progress: () => Promise.resolve(),
		requested,
		state: {},
		token: "fake-token",
	} as unknown as StreamCtx;
	return {
		ctx,
		ids: () => records.map((r) => r.data.id),
		cursor: () => states.at(-1),
	};
}

function mockList(t: TestContext, items: unknown[]): void {
	t.mock.method(globalThis, "fetch", () =>
		Promise.resolve(new Response(JSON.stringify(items), { status: 200 })),
	);
}

const item = (id: number, created: string, updated: string) => ({
	id,
	number: id,
	title: `Issue ${String(id)}`,
	state: "open",
	created_at: created,
	updated_at: updated,
	repository_url: "https://api.github.com/repos/octocat/repo-1",
	user: { login: "octocat", id: 42 },
});

test("collectIssues: until applies to created_at, and the cursor stays below until", async (t) => {
	mockList(t, [
		item(1, "2026-06-01T00:00:00Z", "2026-06-10T00:00:00Z"),
		item(2, "2026-06-06T00:00:00Z", "2026-06-07T00:00:00Z"),
		item(3, "2026-05-01T00:00:00Z", "2026-05-02T00:00:00Z"),
	]);
	const { ctx, ids, cursor } = makeCtx("issues");
	await collectIssues(ctx);
	assert.deepEqual(ids().sort(), [1, 3].map(String).sort());
	assert.deepEqual(cursor(), { last_updated_at: "2026-06-04T23:59:59.000Z" });
});

test("collectGists: until applies to created_at", async (t) => {
	mockList(t, [
		{
			id: "gist-1",
			description: "in range, updated later",
			public: true,
			created_at: "2026-06-01T00:00:00Z",
			updated_at: "2026-06-10T00:00:00Z",
			files: {},
		},
		{
			id: "gist-2",
			description: "created after until",
			public: true,
			created_at: "2026-06-06T00:00:00Z",
			updated_at: "2026-06-06T00:00:00Z",
			files: {},
		},
	]);
	const { ctx, ids } = makeCtx("gists");
	await collectGists(ctx);
	assert.deepEqual(ids(), ["gist-1"]);
});

// Records at or after `until` are withheld by the runtime, so no collector may
// checkpoint past them: the next run would skip records it never delivered.
const CAPPED = "2026-06-04T23:59:59.000Z";

test("collectRepositories: a later pushed_at does not move the cursor past until", async (t) => {
	mockList(t, [
		{
			id: 1,
			name: "in-range",
			full_name: "octocat/in-range",
			private: false,
			owner: { login: "octocat", id: 42 },
			created_at: "2026-06-01T00:00:00Z",
			pushed_at: "2026-06-10T00:00:00Z",
		},
	]);
	const { ctx, cursor } = makeCtx("repositories");
	await collectRepositories(ctx);
	assert.ok(
		JSON.stringify(cursor()).includes(CAPPED),
		JSON.stringify(cursor()),
	);
});

test("collectStarred: a star at or after until does not move the cursor past until", async (t) => {
	mockList(t, [
		{
			starred_at: "2026-06-06T00:00:00Z",
			repo: { id: 7, name: "r", full_name: "acme/r", owner: { login: "acme" } },
		},
	]);
	const { ctx, cursor } = makeCtx("starred");
	await collectStarred(ctx);
	assert.ok(
		JSON.stringify(cursor()).includes(CAPPED),
		JSON.stringify(cursor()),
	);
});

test("collectEvents: an event at or after until does not move the cursor past until", async (t) => {
	mockList(t, [
		{
			id: "e1",
			type: "WatchEvent",
			created_at: "2026-06-06T00:00:00Z",
			repo: { name: "acme/r" },
			actor: { login: "octocat" },
			payload: {},
		},
	]);
	const { ctx, cursor } = makeCtx("events");
	await collectEvents(ctx);
	assert.ok(
		JSON.stringify(cursor()).includes(CAPPED),
		JSON.stringify(cursor()),
	);
});
