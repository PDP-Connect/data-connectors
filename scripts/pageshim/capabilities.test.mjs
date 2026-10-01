// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isPageShimCapable, pageShimIncompatibilities } from "./capabilities.mjs";

const manifest = (name) =>
	JSON.parse(readFileSync(new URL(`../../connectors/${name}/manifest.json`, import.meta.url), "utf8"));

test("PageShim eligibility follows declared runtime binding requirements", () => {
	for (const name of ["strava_browser", "github_browser", "oura_browser"]) {
		const connector = manifest(name);
		assert.equal(isPageShimCapable(connector), true, name);
		assert.equal(connector.mobile.pageshim.enabled, undefined, `${name} must not declare eligibility`);
	}
});

test("the released ChatGPT and Anthropic connectors declare PageShim-compatible features", () => {
	const expected = {
		chatgpt: {
			network: ["same_origin_page_fetch"],
			browser: ["page_navigation", "page_script_evaluation", "page_condition_wait"],
		},
		anthropic: {
			network: ["same_origin_page_fetch"],
			browser: [
				"page_navigation",
				"page_script_evaluation",
				"host_download_capture",
				"host_archive_extraction",
				"host_archive_entry_chunk_read",
			],
		},
	};
	for (const [name, bindings] of Object.entries(expected)) {
		const connector = manifest(name);
		assert.equal(isPageShimCapable(connector), true, name);
		assert.deepEqual(
			Object.fromEntries(
				Object.entries(connector.runtime_requirements.bindings).map(([binding, requirement]) => [
					binding,
					requirement.features,
				]),
			),
			bindings,
			name,
		);
	}
});

test("broad or unsupported requirements fail closed", () => {
	const incomplete = {
		runtime_requirements: {
			bindings: {
				browser: { required: true },
				network: { required: true },
			},
		},
	};
	assert.equal(isPageShimCapable(incomplete), false);
	assert.match(pageShimIncompatibilities(incomplete).join("; "), /features are not declared/);

	const desktop = {
		runtime_requirements: {
			bindings: {
				browser: { required: true, features: ["evaluate"] },
				network: { required: true, features: ["in_page_fetch"] },
				filesystem: { required: true, features: ["read"] },
			},
		},
	};
	assert.equal(isPageShimCapable(desktop), false);
	assert.match(pageShimIncompatibilities(desktop).join("; "), /filesystem is not provided/);
});

test("an explicit mobile field cannot make unsupported bindings eligible", () => {
	const connector = {
		mobile: { pageshim: { enabled: true } },
		runtime_requirements: {
			bindings: {
				browser: { required: true, features: ["captureDownload"] },
				network: { required: true, features: ["httpFetch"] },
			},
		},
	};
	assert.equal(isPageShimCapable(connector), false);
});
