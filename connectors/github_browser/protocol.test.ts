// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Ajv } from "ajv";
import { runConnectorProtocolSubprocess } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { collectGitHubBrowser } from "./collector.ts";
import { validateRecord } from "./schemas.ts";

const readFixture = (name: string): Promise<string> =>
	readFile(
		new URL(`./__fixtures__/synthetic/${name}`, import.meta.url),
		"utf8",
	);

test("browser collection emits valid records and state for each selected legacy stream", async () => {
	const profile = await readFixture("profile.html");
	const repositories = await readFixture("repositories.html");
	const contributionFixture = await readFixture("contributions.html");
	const contributionHeader = contributionFixture.split("<td")[0] ?? "";
	const events: unknown = JSON.parse(await readFixture("events.json"));
	const history: unknown = JSON.parse(await readFixture("history-issue.json"));
	let profilePageLoads = 0;
	const records: Array<{ stream: string; data: Record<string, unknown> }> = [];
	const messages: Array<{ type: string; stream: string | undefined }> = [];
	const state: Record<string, unknown> = {};
	const service = {
		fetchPublicJson: async (url: string): Promise<unknown> =>
			url.includes("events")
				? events
				: url.includes("type%3Apr")
					? { items: [], total_count: 0, incomplete_results: false }
					: {
							...(history as object),
							total_count: (history as { items: unknown[] }).items.length,
							incomplete_results: false,
						},
		now: () => new Date("2026-01-01T00:00:00Z"),
		openPage: async (url: string): Promise<string> => {
			const graphHtml = (startDate: string, endDate: string): string => {
				let html = contributionHeader;
				for (
					let date = new Date(`${startDate}T00:00:00Z`);
					date.toISOString().slice(0, 10) <= endDate;
					date.setUTCDate(date.getUTCDate() + 1)
				) {
					html += `<td class="ContributionCalendar-day" data-date="${date.toISOString().slice(0, 10)}" data-count="1" data-level="1"></td>`;
				}
				return html;
			};
			if (url.includes("?from=")) {
				const year = Number(/from=(\d{4})/u.exec(url)?.[1]);
				return graphHtml(`${year}-01-01`, `${year}-12-31`);
			}
			return url.includes("tab=repositories")
				? repositories
				: url.includes("tab=stars")
					? '<main><div id="user-starred-repos"></div><p>sample-user hasn\'t starred any repositories yet</p></main>'
					: url.endsWith("github.com/")
						? profile
						: url === "https://github.com/sample-user"
							? ++profilePageLoads === 1
								? profile
								: graphHtml("2025-01-02", "2026-01-01")
							: contributionFixture;
		},
		sleep: async () => {},
	};
	await collectGitHubBrowser(
		{
			emit: async (message) => {
				messages.push({
					type: message.type,
					stream: "stream" in message ? message.stream : undefined,
				});
			},
			emitRecord: async (stream, data) => {
				records.push({ stream, data });
			},
			progress: async () => {},
			requested: new Set([
				"profile",
				"repositories",
				"starred",
				"events",
				"contributions",
				"history",
			]),
			state,
		},
		service,
	);
	for (const { stream, data } of records)
		assert.equal(validateRecord(stream, data).ok, true, `${stream} validates`);
	const manifest = JSON.parse(
		await readFile(new URL("./manifest.json", import.meta.url), "utf8"),
	) as {
		streams: Array<{
			name: string;
			primary_key: string[];
			schema: { required: string[]; properties: Record<string, unknown> };
		}>;
	};
	for (const { stream, data } of records) {
		assert.equal(data.id, `sample-user:${stream}`);
		const spec = manifest.streams.find(({ name }) => name === stream);
		assert.deepEqual(spec?.primary_key, ["id"]);
		assert.ok(spec?.schema.required.includes("id"));
		assert.ok(spec?.schema.properties.id);
		assert.equal(
			new Ajv().compile(spec?.schema)(data),
			true,
			`${stream} matches manifest schema`,
		);
	}
	assert.deepEqual(
		new Set(records.map(({ stream }) => stream)),
		new Set([
			"profile",
			"repositories",
			"starred",
			"events",
			"contributions",
			"history",
		]),
	);
	assert.equal(messages.filter(({ type }) => type === "STATE").length, 6);
	assert.equal(
		Array.isArray(
			records.find(({ stream }) => stream === "history")?.data.pullRequests,
		),
		true,
	);
});

test("real runtime emits START-selected six RECORDs before DONE", async () => {
	const streams = [
		"profile",
		"repositories",
		"starred",
		"events",
		"contributions",
		"history",
	];
	const result = await runConnectorProtocolSubprocess({
		cwd: new URL("../../packages/polyfill-connectors/", import.meta.url)
			.pathname,
		entrypoint: new URL("./protocol-runtime-fixture.ts", import.meta.url)
			.pathname,
		start: {
			type: "START",
			scope: { streams: streams.map((name) => ({ name })) },
		},
	});
	assert.equal(result.code, 0);
	const records = result.messages.filter(
		(message) => message.type === "RECORD",
	);
	assert.deepEqual(
		new Set(records.map((message) => message.stream)),
		new Set(streams),
	);
	assert.equal(records.length, 6);
	for (const message of records) {
		if (message.type !== "RECORD") continue;
		assert.equal(message.key, `sample-user:${message.stream}`);
		assert.equal(message.data.id, message.key);
	}
	const done = result.messages.at(-1);
	assert.equal(done?.type, "DONE");
	if (done?.type === "DONE") assert.equal(done.records_emitted, 6);
});

test("inventory follows next link and rejects an unproven empty page", async () => {
	const profile = await readFixture("profile.html");
	const row = await readFixture("repositories.html");
	const visited: string[] = [];
	const emitted: unknown[] = [];
	const messages: Array<{ type: string }> = [];
	const run = async (secondPage: string) => {
		visited.length = 0;
		emitted.length = 0;
		messages.length = 0;
		await collectGitHubBrowser(
			{
				emit: async (message) => {
					messages.push(message);
				},
				emitRecord: async (_stream, data) => {
					emitted.push(data);
				},
				progress: async () => {},
				requested: new Set(["repositories"]),
				state: {},
			},
			{
				fetchPublicJson: async () => ({}),
				now: () => new Date("2026-01-01"),
				sleep: async () => {},
				openPage: async (url) => {
					visited.push(url);
					if (url.endsWith("github.com/")) return profile;
					return url.includes("page=1")
						? `${row}<a class="next_page" rel="next" href="/sample-user?tab=repositories&page=2">Next</a>`
						: secondPage;
				},
			},
		);
	};
	await run(row);
	assert.ok(visited.some((url) => url.includes("page=2")));
	assert.equal(emitted.length, 1);
	await run("<main>Sign in to GitHub</main>");
	assert.equal(emitted.length, 0);
	assert.ok(messages.some((message) => message.type === "SKIP_RESULT"));
	assert.ok(!messages.some((message) => message.type === "STATE"));
});

test("incomplete or contradictory history search cannot emit a completed snapshot", async () => {
	const profile = await readFixture("profile.html");
	for (const response of [
		{ items: [], total_count: 2, incomplete_results: true },
		{ items: [], total_count: 2, incomplete_results: false },
	]) {
		const messages: Array<{ type: string }> = [];
		await collectGitHubBrowser(
			{
				emit: async (message) => {
					messages.push(message);
				},
				emitRecord: async () => {
					throw new Error("unexpected history record");
				},
				progress: async () => {},
				requested: new Set(["history"]),
				state: {},
			},
			{
				fetchPublicJson: async () => response,
				now: () => new Date("2026-01-01"),
				openPage: async () => profile,
				sleep: async () => {},
			},
		);
		assert.ok(messages.some((message) => message.type === "SKIP_RESULT"));
		assert.ok(!messages.some((message) => message.type === "STATE"));
	}
});
