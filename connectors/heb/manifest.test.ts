// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { manifestPath } from "../../packages/polyfill-connectors/src/connector-paths.ts";

const MANIFEST_PATH = manifestPath("heb");

interface HebManifest {
	setup?: {
		credential_capture?: {
			required?: unknown;
			fields?: readonly { name?: unknown; required?: unknown }[];
		};
		modality?: unknown;
	};
	version?: unknown;
	capabilities?: {
		human_interaction?: unknown;
		refresh_policy?: {
			interaction_posture?: unknown;
			rationale?: unknown;
		};
	};
}

test("heb first-time setup allows browser login with optional saved credentials", () => {
	const manifest = JSON.parse(
		readFileSync(MANIFEST_PATH, "utf8"),
	) as HebManifest;
	assert.equal(manifest.version, "0.5.11");
	assert.equal(manifest.setup?.modality, "static_secret");
	assert.equal(manifest.setup?.credential_capture?.required, false);
	assert.deepEqual(
		manifest.setup?.credential_capture?.fields?.map((field) => [
			field.name,
			field.required,
		]),
		[
			["username", false],
			["password", false],
		],
	);
});

test("heb manifest declares otp alongside manual_action and keeps the posture honest", () => {
	const manifest = JSON.parse(
		readFileSync(MANIFEST_PATH, "utf8"),
	) as HebManifest;
	const interactions = Array.isArray(manifest.capabilities?.human_interaction)
		? [...(manifest.capabilities?.human_interaction ?? [])].filter(
				(value): value is string => typeof value === "string",
			)
		: [];

	assert.deepEqual(interactions.sort(), ["manual_action", "otp"]);
	assert.equal(
		manifest.capabilities?.refresh_policy?.interaction_posture,
		"otp_likely",
	);

	const rationale = String(
		manifest.capabilities?.refresh_policy?.rationale ?? "",
	);
	assert.match(rationale, /verification code/i);
	assert.match(rationale, /Incapsula/i);
});
