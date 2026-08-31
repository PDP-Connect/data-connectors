// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	platformOptionKind,
	resolveEnforcedOptionKind,
} from "./connector-config-option-kind-registry.ts";

/**
 * `platformOptionKind` is the platform's decision surface; every other
 * consumer (the schema resolver, the RI's config store) trusts it as the
 * one place a manifest cannot talk its way past. These tests pin the
 * fail-closed default and the hyphen/underscore normalization the registry
 * depends on for its lookups to actually fire.
 */

test("a registered connector+option resolves to its declared kind", () => {
	assert.equal(
		platformOptionKind("slack", "LOOKBACK_DAYS"),
		"collection_scope",
	);
	assert.equal(platformOptionKind("slack", "SKIP_FILES"), "transport");
});

test("an unregistered connector resolves to null, never a guessed kind", () => {
	assert.equal(platformOptionKind("brand_new_connector", "ANYTHING"), null);
});

test("a registered connector's unclassified option resolves to null", () => {
	assert.equal(platformOptionKind("slack", "TOTALLY_UNKNOWN_KNOB"), null);
});

test("lookups normalize hyphenated connector_key spelling to the registry's underscored directory form", () => {
	// Manifests carry the canonical hyphenated form; the registry is written
	// in the underscored directory form. A lookup using either spelling must
	// hit the same entry, or the registry's decisions become dead letters.
	assert.equal(
		platformOptionKind("claude-code", "CLAUDE_CODE_PROJECT_INCLUDE"),
		"collection_scope",
	);
	assert.equal(
		platformOptionKind("claude_code", "CLAUDE_CODE_PROJECT_INCLUDE"),
		"collection_scope",
	);
});

test("resolveEnforcedOptionKind falls back to collection_scope, the restrictive default, never to transport", () => {
	assert.equal(resolveEnforcedOptionKind("slack", "SKIP_FILES"), "transport");
	assert.equal(
		resolveEnforcedOptionKind("slack", "TOTALLY_UNKNOWN_KNOB"),
		"collection_scope",
	);
	assert.equal(
		resolveEnforcedOptionKind("brand_new_connector", "ANYTHING"),
		"collection_scope",
	);
});
