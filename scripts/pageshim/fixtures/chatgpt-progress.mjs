// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import {
	projectChatGptExport,
	syntheticChatGptExport,
} from "../chatgpt-replay.mjs";
import { runFixtureHarness } from "../harness.mjs";
import { createChatGptReplayFixtures } from "./chatgpt-replay.mjs";

const conversationScope = "chatgpt.conversations";
const messageScope = "chatgpt.messages";
const fullScopes = [conversationScope, messageScope];
const listPath = "/backend-api/conversations";
const detailPath = "/backend-api/conversation/";
const json = (body, status = 200) => ({
	body: JSON.stringify(body),
	contentType: "application/json",
	status,
});

export const chatGptProgressScenarios = {
	outOfOrder: {
		size: 3,
		concurrent: true,
		selectedIds: ["conv-0", "conv-1", "conv-2"],
	},
	replacement: {
		size: 1,
		prefix: "replacement",
		selectedIds: ["replacement-0"],
	},
	capped: {
		size: 3,
		cap: 1,
		selectedIds: ["conv-0", "conv-1", "conv-2"],
	},
	partial: {
		size: 3,
		truncateSearch: true,
		selectedIds: ["conv-0", "conv-1", "conv-2"],
	},
	mismatched: {
		size: 3,
		truncatePrimary: true,
		selectedIds: ["conv-0", "conv-1", "conv-2"],
	},
	restricted: {
		size: 3,
		scopes: [
			{
				name: conversationScope,
				time_range: { until: "2026-01-01T00:02:01Z" },
			},
		],
		selectedIds: ["conv-1", "conv-2"],
	},
	failedDetail: {
		size: 3,
		scopes: [conversationScope],
		failIds: ["conv-0", "conv-1"],
		selectedIds: ["conv-0", "conv-1", "conv-2"],
	},
	unsupportedResource: {
		size: 3,
		scopes: [{ name: conversationScope, resources: ["conv-1"] }],
		selectedIds: ["conv-1"],
		mayReject: true,
	},
};

export async function runChatGptProgressScenario(bundle, spec) {
	const scopes = spec.scopes ?? fullScopes;
	const synthetic = syntheticChatGptExport({
		conversations: spec.size,
		messagesPerConversation: 1,
	});
	if (spec.prefix !== undefined) {
		for (const row of synthetic[conversationScope].conversations) {
			row.id = row.id.replace("conv", spec.prefix);
		}
		for (const row of synthetic[messageScope].messages) {
			row.conversation_id = row.conversation_id.replace("conv", spec.prefix);
		}
	}
	const projected = projectChatGptExport(synthetic);
	const fixtures = createChatGptReplayFixtures(projected);
	const resolve = fixtures.resolve;
	const inventory = synthetic[conversationScope].conversations.map(
		({ id }) => id,
	);
	const detailRequests = [];
	const served = [];
	const detailResults = [];
	const packetObservations = [];
	const packets = [];
	const arrivals = new Map();
	const { promise: allQueued, resolve: queued } = Promise.withResolvers();
	const { promise: firstCount, resolve: counted } = Promise.withResolvers();
	const { promise: secondCompleted, resolve: completedSecond } =
		Promise.withResolvers();
	const last = inventory.at(-1);
	fixtures.resolve = async (raw, init) => {
		const url = new URL(raw);
		if (url.pathname === listPath) {
			const offset = Number(url.searchParams.get("offset"));
			const rows = projected
				.listPage(0)
				.items.slice(0, spec.truncatePrimary ? 2 : spec.size);
			return json({ items: rows.slice(offset) });
		}
		if (
			spec.truncateSearch &&
			url.pathname === `${listPath}/search` &&
			Number(url.searchParams.get("cursor")) > 0
		) {
			return json({ unexpected: true });
		}
		if (url.pathname === `${listPath}/batch`) return json({}, 404);
		if (!url.pathname.startsWith(detailPath)) return resolve(raw, init);
		const id = decodeURIComponent(url.pathname.slice(detailPath.length));
		const request = (arrivals.get(id) ?? 0) + 1;
		arrivals.set(id, request);
		const probe = spec.concurrent && request <= 2;
		if (probe) return resolve(raw, init);
		detailRequests.push(id);
		if (spec.concurrent) {
			if (detailRequests.length === spec.size) queued();
			await allQueued;
			// No timers: all three tasks are pending before the last is released.
			// Hold the other responses until the first count actually reaches the bridge.
			if (id !== last) await firstCount;
			if (id === inventory[0]) await secondCompleted;
		}
		const response = spec.failIds?.includes(id)
			? json({}, 404)
			: resolve(raw, init);
		served.push({ id, status: response.status });
		return response;
	};
	const run = await runFixtureHarness({
		bundle,
		fixtures,
		scopes,
		fixtureReady: true,
		timerScale: 0.05,
		clockNowMs: Date.parse("2026-11-28T06:00:00Z"),
		env: {
			PDPP_CHATGPT_PACING_INITIAL_INTERVAL_MS: "0",
			PDPP_CHATGPT_PACING_MIN_INTERVAL_MS: "0",
			...(spec.concurrent
				? {
						PDPP_CHATGPT_DETAIL_INITIAL_CONCURRENCY_PROBE: "3",
						PDPP_CHATGPT_DETAIL_MAX_CONCURRENCY_PROBE: "3",
					}
				: {}),
			...(spec.cap === undefined
				? {}
				: { PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN: String(spec.cap) }),
		},
		observeBridge(method, args, result) {
			// This is the provider evaluation reply, observed before the connector
			// resumes. Status-only preflight replies do not contain a mapping.
			if (
				method === "evaluate" &&
				result?.value?.status === 200 &&
				result.value.json?.mapping
			) {
				const { id } = result.value.json;
				detailResults.push(id);
				if (id === inventory[1]) completedSecond();
			}
			if (method !== "setProgress") return;
			const [packet] = args;
			packets.push(packet);
			packetObservations.push({
				packetIndex: packets.length - 1,
				detailIds: [...detailResults],
			});
			if (packet.message.startsWith("Synced ")) counted();
		},
	});
	if (!spec.mayReject) {
		assert.deepEqual(run.ret, { ok: true }, run.log.slice(-18).join("\n"));
		assert.equal(run.data.error, undefined);
	}
	const conversationRecords = run.result?.[conversationScope]?.records ?? [];
	const messageRecords = run.result?.[messageScope]?.records ?? [];
	return {
		scopes,
		inventory,
		selectedIds: spec.selectedIds,
		detailRequests,
		served,
		completedIds: detailResults,
		packets,
		packetObservations,
		emittedConversationIds: conversationRecords.map(({ id }) => id),
		emittedMessageConversationIds: messageRecords.map(
			({ conversation_id }) => conversation_id,
		),
		errors: run.result?.errors ?? [],
		...(run.data.error === undefined ? {} : { error: run.data.error }),
	};
}
