#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildPageshim } from "./build.mjs";
import { resolveBridgeLatencyMs, runHarness } from "./harness.mjs";
import { readChatGptExport } from "./chatgpt-replay.mjs";
import { createChatGptFixtures } from "./fixtures/chatgpt.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { values } = parseArgs({
	options: {
		export: { type: "string" },
		"bridge-latency-ms": { type: "string" },
	},
});
if (values["bridge-latency-ms"] !== undefined)
	process.env.PAGESHIM_BRIDGE_LATENCY_MS = values["bridge-latency-ms"];

const bundle = join(root, ".scratch", "pageshim-chatgpt-replay.js");
mkdirSync(dirname(bundle), { recursive: true });
const { outfile } = await buildPageshim({ connector: "chatgpt", outfile: bundle });
const projected = readChatGptExport(values.export);
const fixtures = createChatGptFixtures(projected);
const run = await runHarness({
	bundle: outfile,
	fixtures,
	scopes: ["chatgpt.conversations", "chatgpt.messages"],
	bridgeLatencyMs: resolveBridgeLatencyMs(),
});
if (run.ret?.ok !== true) throw new Error("ChatGPT PageShim replay did not complete");
const conversationCount =
	run.result?.["chatgpt.conversations"]?.records?.length ?? 0;
const emittedMessageCount =
	run.result?.["chatgpt.messages"]?.records?.length ?? 0;
const bridge = run.bridgeMetrics;
const perConversation = (value) =>
	conversationCount > 0 ? value / conversationCount : null;
const methods = Object.entries(bridge.byMethod).map(([method, metrics]) => ({
	method,
	...metrics,
	totalBytes: metrics.requestBytes + metrics.responseBytes,
}));
const output = {
	shapeApproximate: true,
	providerPageSize: 30,
	conversationCount,
	emittedMessageCount,
	sourceConversationCount: projected.stats.conversations,
	sourceMessageCount: projected.stats.messages,
	bridgeLatencyMsPerCall: bridge.latencyMsPerCall,
	bridgeRoundTrips: bridge.roundTrips,
	bridgeBytes: bridge.totalBytes,
	modeledPhoneTimeSeconds: bridge.modeledPhoneTimeMs / 1000,
	perConversation: {
		roundTrips: perConversation(bridge.roundTrips),
		bytes: perConversation(bridge.totalBytes),
		modeledPhoneSeconds: perConversation(bridge.modeledPhoneTimeMs) / 1000,
	},
	byMethod: methods.sort((a, b) => b.totalBytes - a.totalBytes),
};
if (conversationCount !== projected.stats.conversations)
	throw new Error("ChatGPT replay emitted a different conversation count than its source");
console.log(JSON.stringify(output, null, 2));
