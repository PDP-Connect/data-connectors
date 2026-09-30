// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PAGE_SHIM_BINDING_FEATURES = {
	browser: new Set([
		"page_navigation",
		"page_script_evaluation",
		"page_content_read",
		"page_condition_wait",
		"host_http_request",
		"host_download_capture",
		"host_archive_extraction",
		"host_archive_entry_chunk_read",
	]),
	network: new Set(["same_origin_page_fetch", "host_http_request"]),
};

export function pageShimIncompatibilities(manifest) {
	const bindings = manifest.runtime_requirements?.bindings;
	if (!bindings || typeof bindings !== "object") return ["runtime bindings are missing"];
	const required = Object.entries(bindings).filter(([, value]) => value?.required === true);
	const failures = [];
	if (!required.some(([name]) => name === "browser")) failures.push("browser binding is not required");
	if (!required.some(([name]) => name === "network")) failures.push("network binding is not required");
	for (const [name, requirement] of required) {
		const supported = PAGE_SHIM_BINDING_FEATURES[name];
		if (!supported) {
			failures.push(`required binding ${name} is not provided`);
			continue;
		}
		if (!Array.isArray(requirement.features) || requirement.features.length === 0) {
			failures.push(`required ${name} features are not declared`);
			continue;
		}
		for (const feature of requirement.features) {
			if (!supported.has(feature)) failures.push(`${name} feature ${feature} is not provided`);
		}
	}
	return failures;
}

export function isPageShimCapable(manifest) {
	return pageShimIncompatibilities(manifest).length === 0;
}

export function pageShimConnectors(repositoryRoot) {
	return readdirSync(join(repositoryRoot, "connectors"))
		.filter((name) => {
			try {
				const manifest = JSON.parse(
					readFileSync(join(repositoryRoot, "connectors", name, "manifest.json"), "utf8"),
				);
				return isPageShimCapable(manifest);
			} catch {
				return false;
			}
		})
		.sort();
}
