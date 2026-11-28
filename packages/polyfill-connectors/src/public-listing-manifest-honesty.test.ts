// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import test from "node:test";
import {
	manifestPath as MANIFEST_PATH,
	manifestFileNames,
} from "./connector-paths.ts";

const names = manifestFileNames()
	.filter((name) => name.endsWith(".json"))
	.sort();
const tiers = new Set(["supported", "preview", "development"]);
interface Manifest {
	capabilities?: {
		public_listing?: { tier?: string; listed?: unknown; status?: unknown };
	};
}

function isManifest(value: unknown): value is Manifest {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function manifest(name: string): Manifest {
	const value: unknown = JSON.parse(
		readFileSync(MANIFEST_PATH(name.replace(/\.json$/, "")), "utf8"),
	);
	assert.ok(isManifest(value), `${name} must contain a manifest object`);
	return value;
}

test("every shipped manifest declares exactly one typed public lifecycle tier", () => {
	assert.equal(names.length, 69);
	for (const name of names) {
		const { capabilities } = manifest(name);
		const { public_listing: listing } = capabilities ?? {};
		assert.ok(listing, `${name} must declare public_listing`);
		assert.ok(
			!Object.hasOwn(listing ?? {}, "listed"),
			`${name} must not declare legacy listed`,
		);
		assert.ok(
			!Object.hasOwn(listing ?? {}, "status"),
			`${name} must not declare legacy status`,
		);
		assert.ok(
			typeof listing.tier === "string" && tiers.has(listing.tier),
			`${name} has invalid tier ${String(listing.tier)}`,
		);
	}
});

test("development is the only non-offered lifecycle tier", () => {
	for (const name of names) {
		const { capabilities } = manifest(name);
		const { public_listing: listing } = capabilities ?? {};
		assert.ok(listing?.tier, `${name} must declare a tier`);
		const { tier } = listing;
		assert.ok(tiers.has(tier));
	}
});

test("recent or non-repeatable live evidence stays Preview", () => {
	for (const name of ["apple_contacts.json", "anthropic_live.json"]) {
		const { capabilities } = manifest(name);
		const { public_listing: listing } = capabilities ?? {};
		assert.equal(listing?.tier, "preview");
	}
});

test("connectors demoted for unproven freeze-era reliability stay unlisted or Preview", () => {
	const expected: Record<string, string> = {
		"heb.json": "preview",
		"usaa.json": "preview",
		"gmail.json": "preview",
		"groupme.json": "development",
	};
	for (const [name, expectedTier] of Object.entries(expected)) {
		const { capabilities } = manifest(name);
		const { public_listing: listing } = capabilities ?? {};
		assert.equal(
			listing?.tier,
			expectedTier,
			`${name} must stay at lifecycle tier "${expectedTier}" until its freeze condition is proven`,
		);
	}
});

import {
	PRODUCTION_READY_CONNECTORS,
	REAL_UNLISTED_CONNECTORS,
} from "./connector-conformance-roster.ts";

test("conformance oracle names are unique across visible and development collectors", () => {
	const files = [
		...Object.values(PRODUCTION_READY_CONNECTORS),
		...Object.values(REAL_UNLISTED_CONNECTORS),
	].map(({ testFile }) => testFile);
	assert.equal(new Set(files).size, files.length);
});

test("a conformance oracle is a test file owned by the connector it represents", () => {
	for (const [key, { testFile }] of [
		...Object.entries(PRODUCTION_READY_CONNECTORS),
		...Object.entries(REAL_UNLISTED_CONNECTORS),
	]) {
		assert.ok(testFile.startsWith(`connectors/${key}/`), key);
		assert.ok(testFile.endsWith(".test.ts"), key);
	}
});
