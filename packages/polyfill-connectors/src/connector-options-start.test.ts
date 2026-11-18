// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner-confirmed settings reach a connector: START.connector_options is
 * threaded onto the collect context, read through `readOptions`, and every
 * setting a connector reads is declared in its manifest and classified by the
 * platform registry. The env fallback keeps current deployments working.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	CHATGPT_OPTION_NAMES,
	CHATGPT_OPTIONS_ENV_PREFIX,
	resolveChatGptBackendFetchTimeoutMs,
	resolveChatGptDetailLaneTuning,
	resolveChatGptMaxRunWallClockMs,
	resolveChatGptMaxTailDeferralGapsPerRun,
	resolveChatGptProviderBudget,
} from "../../../connectors/chatgpt/index.ts";
import {
	isChatGptStatelessFlag,
	resolveUsageDetailPlan,
} from "../../../connectors/chatgpt/usage-stream.ts";
import {
	GMAIL_OPTION_NAMES,
	GMAIL_OPTIONS_ENV_PREFIX,
	resolveAttachmentBackfillPageByteBudget,
	resolveMaxAttachmentBytes,
} from "../../../connectors/gmail/index.ts";
import { readSlackBrowserOptions } from "../../../connectors/slack_browser/index.ts";
import { platformOptionKind } from "./connector-config-option-kind-registry.ts";
import { readOptionsAsEnv } from "./connector-options.ts";
import { resolveOptionsSchemaFromManifest } from "./connector-options-schema.ts";
import { manifestPath, packageRoot } from "./connector-paths.ts";
import { runConnectorProtocolSubprocess } from "./test-harness.ts";

const GMAIL_MAX = "PDPP_GMAIL_MAX_ATTACHMENT_BYTES";

function withEnv(key: string, value: string | undefined, body: () => void) {
	const saved = process.env[key];
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
	try {
		body();
	} finally {
		if (saved === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = saved;
		}
	}
}

test("a confirmed START option beats the env variable; env applies when START is silent", () => {
	withEnv(GMAIL_MAX, "2000", () => {
		const fromStart = readOptionsAsEnv(
			{ connector_options: { MAX_ATTACHMENT_BYTES: 1000 } },
			GMAIL_OPTIONS_ENV_PREFIX,
			GMAIL_OPTION_NAMES,
		);
		assert.equal(resolveMaxAttachmentBytes(fromStart), 1000);

		const fromEnv = readOptionsAsEnv(
			undefined,
			GMAIL_OPTIONS_ENV_PREFIX,
			GMAIL_OPTION_NAMES,
		);
		assert.equal(resolveMaxAttachmentBytes(fromEnv), 2000);
	});
	withEnv(GMAIL_MAX, undefined, () => {
		const neither = readOptionsAsEnv(
			{ connector_options: {} },
			GMAIL_OPTIONS_ENV_PREFIX,
			GMAIL_OPTION_NAMES,
		);
		assert.equal(resolveMaxAttachmentBytes(neither), 25 * 1024 * 1024);
	});
});

test("a bad START value is ignored the way a bad env value is", () => {
	const env = readOptionsAsEnv(
		{
			connector_options: {
				ATTACHMENT_BACKFILL_PAGE_BYTES: "not a number",
				MAX_ATTACHMENT_BYTES: -5,
			},
		},
		GMAIL_OPTIONS_ENV_PREFIX,
		GMAIL_OPTION_NAMES,
	);
	assert.equal(resolveMaxAttachmentBytes(env), 25 * 1024 * 1024);
	assert.equal(resolveAttachmentBackfillPageByteBudget(env), 1024 * 1024);
});

test("ChatGPT pacing and run bounds come from START", () => {
	const env = readOptionsAsEnv(
		{
			connector_options: {
				CIRCUIT_BREAKER: false,
				MAX_RUN_WALL_CLOCK_MS: 90_000,
				PACING_MIN_INTERVAL_MS: 400,
			},
		},
		CHATGPT_OPTIONS_ENV_PREFIX,
		CHATGPT_OPTION_NAMES,
	);
	assert.equal(resolveChatGptMaxRunWallClockMs(env), 90_000);
	assert.equal(env.PDPP_CHATGPT_CIRCUIT_BREAKER, "false");
	assert.notEqual(resolveChatGptProviderBudget(env, null), null);
});

test("ChatGPT tail bound, timeout, probes and usage detail come from START over env", () => {
	const previous = process.env.PDPP_CHATGPT_BACKEND_FETCH_TIMEOUT_MS;
	process.env.PDPP_CHATGPT_BACKEND_FETCH_TIMEOUT_MS = "10000";
	try {
		const env = readOptionsAsEnv(
			{
				connector_options: {
					BACKEND_FETCH_TIMEOUT_MS: 60_000,
					DETAIL_MAX_CONCURRENCY_PROBE: 3,
					DETAIL_INITIAL_CONCURRENCY_PROBE: 2,
					MAX_TAIL_DEFERRAL_GAPS_PER_RUN: "7",
					PACING_RECOVERY_GAIN: "0.4",
					RETRY_BUDGET_INITIAL_TOKENS: 3,
					USAGE_DETAIL: 12,
					ACCOUNT_PLAN_STATELESS: true,
					USAGE_STATELESS: true,
				},
			},
			CHATGPT_OPTIONS_ENV_PREFIX,
			CHATGPT_OPTION_NAMES,
		);
		assert.equal(resolveChatGptBackendFetchTimeoutMs(env), 60_000);
		assert.equal(resolveChatGptMaxTailDeferralGapsPerRun(env), 7);
		assert.equal(resolveUsageDetailPlan(env).size, 12);
		assert.equal(
			isChatGptStatelessFlag(env.PDPP_CHATGPT_USAGE_STATELESS),
			true,
		);
		assert.equal(
			isChatGptStatelessFlag(env.PDPP_CHATGPT_ACCOUNT_PLAN_STATELESS),
			true,
		);
		const lane = resolveChatGptDetailLaneTuning(env);
		assert.equal(lane.initialConcurrency, 2);
		assert.equal(lane.maxConcurrency, 3);
		assert.notEqual(resolveChatGptProviderBudget(env, null), null);
		// With no START value the env name still applies.
		const fallback = readOptionsAsEnv(
			{ connector_options: {} },
			CHATGPT_OPTIONS_ENV_PREFIX,
			CHATGPT_OPTION_NAMES,
		);
		assert.equal(resolveChatGptBackendFetchTimeoutMs(fallback), 10_000);
	} finally {
		if (previous === undefined) {
			delete process.env.PDPP_CHATGPT_BACKEND_FETCH_TIMEOUT_MS;
		} else {
			process.env.PDPP_CHATGPT_BACKEND_FETCH_TIMEOUT_MS = previous;
		}
	}
});

test("Slack reads its settings from START, with the env fallback", () => {
	const options = readSlackBrowserOptions({
		CHANNEL_ALLOWLIST: ["C1", "C2"],
		LOOKBACK_DAYS: 3,
	});
	assert.deepEqual(options.channelAllowlist, ["C1", "C2"]);
	assert.equal(options.lookbackDays, 3);
});

for (const [key, names] of [
	["gmail", GMAIL_OPTION_NAMES],
	["chatgpt", CHATGPT_OPTION_NAMES],
	[
		"slack-browser",
		[
			"CHANNEL_ALLOWLIST",
			"CHANNEL_TYPES",
			"LOOKBACK_DAYS",
			"MAX_BACKFILL_DAYS",
			"WORKSPACE",
		],
	],
] as const) {
	test(`${key}: the manifest declares exactly the settings the connector reads, each classified by the platform`, () => {
		const file = key.replaceAll("-", "_");
		const manifest = JSON.parse(readFileSync(manifestPath(file), "utf8"));
		const schema = resolveOptionsSchemaFromManifest(manifest, file);
		assert.ok(schema, `${key} must declare options_schema`);
		assert.deepEqual(
			schema.options.map((option) => option.optionKey),
			[...names].sort(),
		);
		for (const option of schema.options) {
			assert.ok(
				platformOptionKind(key, option.optionKey),
				`${key}.${option.optionKey} must be classified in the platform registry`,
			);
		}
	});
}

test("a real connector process receives START.connector_options through readOptions", async () => {
	const run = (
		connectorOptions: Record<string, unknown> | undefined,
		env: NodeJS.ProcessEnv = {},
	) =>
		runConnectorProtocolSubprocess({
			cwd: packageRoot,
			entrypoint: fileURLToPath(
				new URL(
					"./test-fixtures/connector-options-echo-fixture.ts",
					import.meta.url,
				),
			),
			env,
			start: {
				...(connectorOptions ? { connector_options: connectorOptions } : {}),
				scope: { streams: [{ name: "items" }] },
				type: "START",
			},
		});
	const echoed = (result: Awaited<ReturnType<typeof run>>): unknown => {
		const progress = result.messages.find(
			(m) =>
				m.type === "PROGRESS" &&
				"message" in m &&
				String(m.message).startsWith("options "),
		) as { message: string } | undefined;
		return progress
			? JSON.parse(progress.message.slice("options ".length))
			: null;
	};

	assert.deepEqual(echoed(await run({ PAGE_SIZE: 25, SKIP_FILES: true })), {
		PAGE_SIZE: 25,
		SKIP_FILES: true,
	});
	assert.deepEqual(echoed(await run(undefined)), {
		PAGE_SIZE: 10,
		SKIP_FILES: false,
	});
	assert.deepEqual(
		echoed(await run(undefined, { ECHO_FIXTURE_PAGE_SIZE: "40" })),
		{
			PAGE_SIZE: 40,
			SKIP_FILES: false,
		},
	);
	assert.deepEqual(
		echoed(await run({ PAGE_SIZE: 7 }, { ECHO_FIXTURE_PAGE_SIZE: "40" })),
		{
			PAGE_SIZE: 7,
			SKIP_FILES: false,
		},
	);
});
