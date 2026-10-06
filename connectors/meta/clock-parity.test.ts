// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { waitForLegacyPostsCapture } from "./index.ts";

type TimedResponse = { atMs: number; body: unknown };

const emptyBody = {
	data: {
		xdt_api__v1__feed__user_timeline_graphql_connection: {
			edges: [],
			page_info: { has_next_page: false },
		},
	},
};
const populatedBody = {
	data: {
		xdt_api__v1__feed__user_timeline_graphql_connection: {
			edges: [{ node: { id: "post-1" } }],
			page_info: { has_next_page: false },
		},
	},
};

function decision(body: unknown): "data" | "empty" | "not-proven" {
	if (!body || typeof body !== "object") {
		return "not-proven";
	}
	const data = (
		body as {
			data?: {
				xdt_api__v1__feed__user_timeline_graphql_connection?: {
					edges?: unknown;
				};
			};
		}
	).data;
	const edges = data?.xdt_api__v1__feed__user_timeline_graphql_connection?.edges;
	if (!Array.isArray(edges)) {
		return "not-proven";
	}
	return edges.length === 0 ? "empty" : "data";
}

async function runLegacyLoop(
	responses: TimedResponse[],
): Promise<"data" | "empty" | "not-proven"> {
	let now = 0;
	const pending = [...responses].sort((a, b) => a.atMs - b.atMs);
	const captured = new Map<string, { data: unknown }>();
	const page = {
		getCapturedResponse: async (key: string) => captured.get(key) ?? null,
		sleep: async (ms: number) => {
			now += ms;
			while (
				pending.length > 0 &&
				(pending[0]?.atMs ?? Number.POSITIVE_INFINITY) <= now
			) {
				const response = pending.shift();
				if (response?.body) {
					captured.set("postsResponse", { data: response.body });
				}
			}
		},
	};
	const source = `
		(async () => {
			let postsData = null;
			let attempts = 0;
			const maxAttempts = 30;
			await page.sleep(3000);
			while (attempts < maxAttempts && !postsData) {
				await page.sleep(1000);
				attempts++;
				postsData = await page.getCapturedResponse("postsResponse");
			}
			return postsData?.data ?? null;
		})()
	`;
	const selected = await runInNewContext(source, { page });
	return decision(selected);
}

async function runPdppLoop(
	responses: TimedResponse[],
): Promise<"data" | "empty" | "not-proven"> {
	let now = 0;
	const pending = [...responses].sort((a, b) => a.atMs - b.atMs);
	const matching: unknown[] = [];
	const sleep = async (ms: number): Promise<void> => {
		now += ms;
		while (
			pending.length > 0 &&
			(pending[0]?.atMs ?? Number.POSITIVE_INFINITY) <= now
		) {
			const response = pending.shift();
			if (response?.body) {
				matching.push(response.body);
			}
		}
	};
	const selected = await waitForLegacyPostsCapture(matching, { sleep });
	return decision(selected);
}

async function assertDifferential(responses: TimedResponse[]): Promise<void> {
	assert.equal(
		await runPdppLoop(responses),
		await runLegacyLoop(responses),
		JSON.stringify(responses.map(({ atMs }) => atMs)),
	);
}

test("meta posts capture clock matches the legacy polling loop over timed responses", async () => {
	await assertDifferential([
		{ atMs: 4_200, body: emptyBody },
		{ atMs: 4_800, body: populatedBody },
	]);
	const failOpenBodies: unknown[] = [
		{ errors: [{ message: "unauthenticated" }] },
		{
			data: {
				xdt_api__v1__feed__user_timeline_graphql_connection: {
					edges: null,
				},
			},
		},
	];
	for (const body of failOpenBodies) {
		await assertDifferential([{ atMs: 200, body }]);
		assert.equal(await runPdppLoop([{ atMs: 200, body }]), "not-proven");
	}

	let oneResponseCases = 0;
	for (let atMs = 0; atMs <= 31_000; atMs += 100) {
		for (const body of [emptyBody, populatedBody]) {
			await assertDifferential([{ atMs, body }]);
			oneResponseCases += 1;
		}
	}

	let twoResponseCases = 0;
	const dense = Array.from({ length: 81 }, (_, index) => index * 100);
	const coarse = Array.from({ length: 63 }, (_, index) => index * 500);
	for (const grid of [dense, coarse]) {
		for (const firstMs of grid) {
			for (const secondMs of grid) {
				for (const firstBody of [emptyBody, populatedBody]) {
					for (const secondBody of [emptyBody, populatedBody]) {
						await assertDifferential([
							{ atMs: firstMs, body: firstBody },
							{ atMs: secondMs, body: secondBody },
						]);
						twoResponseCases += 1;
					}
				}
			}
		}
	}
	assert.equal(oneResponseCases, 622);
	assert.equal(twoResponseCases, 42_120);
});
