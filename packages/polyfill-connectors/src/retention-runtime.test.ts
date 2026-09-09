// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { z } from "zod";
import {
	checkRetentionCompatibility,
	RETENTION_REQUIRED_CAPABILITIES,
	RETENTION_STREAMS,
} from "./retention-runtime.ts";

const supported = {
	format_versions: [1],
	capabilities: [...RETENTION_REQUIRED_CAPABILITIES],
	streams: Object.keys(RETENTION_STREAMS),
};

test("retention requires explicit runtime support, not ordinary collection success", () => {
	for (const absent of [undefined, null, {}, { success: true }]) {
		assert.deepEqual(checkRetentionCompatibility(absent), {
			available: false,
			reason: "retention_unavailable",
			missing: ["runtime_support"],
		});
	}
	assert.deepEqual(checkRetentionCompatibility(supported), {
		available: true,
		format_version: 1,
	});
});

test("each missing capability and stream grant prevents retention activation", () => {
	for (const capability of RETENTION_REQUIRED_CAPABILITIES) {
		assert.deepEqual(
			checkRetentionCompatibility({
				...supported,
				capabilities: supported.capabilities.filter(
					(name) => name !== capability,
				),
			}),
			{
				available: false,
				reason: "retention_unavailable",
				missing: [`capability:${capability}`],
			},
		);
	}
	for (const stream of supported.streams) {
		assert.deepEqual(
			checkRetentionCompatibility({
				...supported,
				streams: supported.streams.filter((name) => name !== stream),
			}),
			{
				available: false,
				reason: "retention_unavailable",
				missing: [`stream:${stream}`],
			},
		);
	}
});

test("unknown future versions do not imply v1 compatibility", () => {
	assert.deepEqual(
		checkRetentionCompatibility({ ...supported, format_versions: [2] }),
		{
			available: false,
			reason: "retention_unavailable",
			missing: ["format_version:1"],
		},
	);
});

test("retention streams remain dormant in both installed connector profiles", () => {
	const manifestSchema = z.object({
		streams: z.array(z.object({ name: z.string() })),
		profiles: z.array(
			z.object({ streams: z.array(z.object({ name: z.string() })) }),
		),
	});
	for (const connector of ["claude_code", "codex"]) {
		const manifest = manifestSchema.parse(
			JSON.parse(
				readFileSync(
					new URL(`../manifests/${connector}.json`, import.meta.url),
					"utf8",
				),
			),
		);
		const names = [
			...manifest.streams,
			...manifest.profiles.flatMap((profile) => profile.streams),
		];
		assert.equal(
			names.some(({ name }) => supported.streams.includes(name)),
			false,
		);
	}
});
