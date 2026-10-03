// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { isPageShimCapable, pageShimConnectors, pageShimIncompatibilities } from "./capabilities.mjs";

const manifest = (name) =>
	JSON.parse(readFileSync(new URL(`../../connectors/${name}/manifest.json`, import.meta.url), "utf8"));

test("PageShim eligibility follows declared runtime binding requirements", () => {
	assert.deepEqual(pageShimConnectors(fileURLToPath(new URL("../..", import.meta.url))), [
		"anthropic",
		"chatgpt",
		"github_browser",
		"oura_browser",
		"strava_browser",
	]);
	for (const name of ["strava_browser", "github_browser", "oura_browser", "chatgpt", "anthropic"]) {
		const connector = manifest(name);
		assert.equal(isPageShimCapable(connector), true, name);
		assert.equal(connector.mobile.pageshim.enabled, undefined, `${name} must not declare eligibility`);
	}
});

test("host-neutral features preserve PageShim eligibility and are schema enums", () => {
	const expected = [
		"page_navigation",
		"page_script_evaluation",
		"page_content_read",
		"page_condition_wait",
		"same_origin_page_fetch",
		"host_http_request",
		"host_download_capture",
		"host_archive_extraction",
		"host_archive_entry_chunk_read",
		"page_input",
		"cookie_read",
		"page_response_observation",
		"host_cookie_jar_request",
	];
	const catalogSchema = JSON.parse(
		readFileSync(new URL("../../schemas/connector-catalog.schema.json", import.meta.url), "utf8"),
	);
	const manifestSchema = JSON.parse(
		readFileSync(new URL("../../schemas/connector-manifest.schema.json", import.meta.url), "utf8"),
	);
	const mobileGuide = readFileSync(new URL("../../docs/add-a-connector-to-mobile.md", import.meta.url), "utf8");
	const implementationIndexSchema = JSON.parse(
		readFileSync(new URL("../../schemas/connector-implementation-index.schema.json", import.meta.url), "utf8"),
	);
	const featureRef = `${manifestSchema.$id}#/$defs/bindingFeature`;
	assert.deepEqual(manifestSchema.$defs.bindingFeature.enum, expected);
	for (const feature of expected) {
		assert.match(manifestSchema.$defs.bindingFeature.description, new RegExp(`- ${feature}: .+`));
		assert.ok(mobileGuide.includes(`| \`${feature}\` |`), `${feature} must be documented`);
	}
	assert.equal(catalogSchema.$defs.bindings.additionalProperties.properties.features.items.$ref, featureRef);
	assert.equal(
		implementationIndexSchema.properties.connectors.items.properties.manifest.properties.runtime_requirements.properties.bindings.additionalProperties.properties.features.items.$ref,
		featureRef,
	);
	const manifestAjv = new Ajv2020({ strict: false, validateFormats: false });
	const validateManifest = manifestAjv.compile(manifestSchema);
	const connectorsDirectory = fileURLToPath(new URL("../../connectors/", import.meta.url));
	// Collection Profile Section 3.3.8 gives each feature exactly one providing
	// kind. github_browser and strava_browser already declare host_http_request
	// on both browser and network (also flagged by the binding-model fit test);
	// schemas/connector-manifest.schema.test.mjs documents and tests this same
	// known exception in detail. This loop only needs to not treat it as a
	// schema regression here.
	const knownFeatureOwnershipViolations = new Set(["github_browser", "strava_browser"]);
	for (const name of readdirSync(connectorsDirectory)) {
		const manifestPath = `${connectorsDirectory}/${name}/manifest.json`;
		if (!existsSync(manifestPath)) continue;
		if (knownFeatureOwnershipViolations.has(name)) continue;
		assert.equal(
			validateManifest(JSON.parse(readFileSync(manifestPath, "utf8"))),
			true,
			`${name}: ${JSON.stringify(validateManifest.errors)}`,
		);
	}
	const catalogAjv = new Ajv2020({ strict: false, validateFormats: false });
	catalogAjv.addSchema(manifestSchema);
	const validateCatalog = catalogAjv.compile(catalogSchema);
	const catalogConnector = {
		connector_key: "synthetic",
		connector_id: "https://registry.pdpp.dev/connectors/synthetic",
		display_name: "Synthetic",
		tier: "development",
		runtime_requirements: {
			bindings: { browser: { required: true, features: ["page_navigation"] } },
		},
		setup: { modality: null },
		latest: { version: "1.0.0", digest: `sha256:${"a".repeat(64)}` },
		versions: [{ version: "1.0.0", digest: `sha256:${"a".repeat(64)}` }],
	};
	const catalog = {
		catalog_version: "1.0",
		generated_at: "2026-09-30T00:00:00Z",
		source_commit: "a".repeat(40),
		connectors: [catalogConnector],
	};
	assert.equal(validateCatalog(catalog), true, JSON.stringify(validateCatalog.errors));
	for (const name of ["evaluate", "goto", "content", "waitForFunction", "request.get", "in_page_fetch", "httpFetch"]) {
		const binding = name === "in_page_fetch" || name === "httpFetch" ? "network" : "browser";
		catalogConnector.runtime_requirements.bindings = {
			browser: { required: true, features: ["page_navigation"] },
			network: { required: true, features: ["same_origin_page_fetch"] },
			[binding]: { required: true, features: [name] },
		};
		assert.equal(validateCatalog(catalog), false, name);
	}

	const indexAjv = new Ajv2020({ strict: false, validateFormats: false });
	indexAjv.addSchema(manifestSchema);
	const validateIndex = indexAjv.compile(implementationIndexSchema);
	const implementationIndex = JSON.parse(
		readFileSync(new URL("../../connector-implementation-index.json", import.meta.url), "utf8"),
	);
	assert.equal(validateIndex(implementationIndex), true, JSON.stringify(validateIndex.errors));
	const unknownFeatureIndex = structuredClone(implementationIndex);
	unknownFeatureIndex.connectors[0].manifest.runtime_requirements.bindings.browser.features = ["evaluate"];
	assert.equal(validateIndex(unknownFeatureIndex), false);

	const capabilityConnector = {
		runtime_requirements: {
			bindings: {
				browser: { required: true, features: ["page_script_evaluation", "page_navigation"] },
				network: { required: true, features: ["same_origin_page_fetch"] },
			},
		},
	};
	assert.equal(isPageShimCapable(capabilityConnector), true);
});

test("all five declared mobile connectors remain PageShim eligible", () => {
	const expected = {
		github_browser: {
			network: ["host_http_request"],
			browser: [
				"page_script_evaluation",
				"page_navigation",
				"page_content_read",
				"page_condition_wait",
				"host_http_request",
			],
		},
		oura_browser: {
			network: ["same_origin_page_fetch"],
			browser: ["page_script_evaluation", "page_navigation"],
		},
		strava_browser: {
			network: ["same_origin_page_fetch", "host_http_request"],
			browser: ["page_script_evaluation", "page_navigation", "host_http_request"],
		},
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
	assert.deepEqual(
		pageShimConnectors(fileURLToPath(new URL("../..", import.meta.url))),
		Object.keys(expected).sort(),
	);
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
				browser: { required: true, features: ["page_script_evaluation"] },
				network: { required: true, features: ["same_origin_page_fetch"] },
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

test("PageShim rejects legacy API method names as capability declarations", () => {
	const legacyNames = [
		"evaluate",
		"goto",
		"content",
		"waitForFunction",
		"request.get",
		"in_page_fetch",
		"httpFetch",
	];
	for (const name of legacyNames) {
		const binding = name === "in_page_fetch" || name === "httpFetch" ? "network" : "browser";
		const connector = {
			runtime_requirements: {
				bindings: {
					browser: { required: true, features: ["page_navigation"] },
					network: { required: true, features: ["same_origin_page_fetch"] },
					[binding]: { required: true, features: [name] },
				},
			},
		};
		assert.equal(isPageShimCapable(connector), false, name);
	}
});
