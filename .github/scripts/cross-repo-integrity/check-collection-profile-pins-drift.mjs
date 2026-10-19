#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift job (b): data-connect's Collection Profile pins against this repo's registry and
 * publish inventory.
 *
 * data-connect's local collector no longer compiles vendored copies of the connectors. It
 * installs signed Collection Profile releases that this repo publishes, pinned in
 * `packages/local-collector/src/generated/collection-profile-pins.generated.ts`
 * (`COLLECTION_PROFILE_PINS`: `{connectorId, connectorKey, version, digest, ...}`). That list
 * and this repo's `LOCAL_COLLECTOR_DEFINITIONS` registry are edited in separate repositories,
 * so they can drift, and each direction ships a broken collector:
 *
 *   - a registry connector that is published but has no pin   -> the collector advertises a
 *     connector it cannot install.
 *   - a pin for a connector the registry does not declare     -> the collector installs a
 *     release nothing in the registry can run.
 *   - a pin whose connectorKey differs from the inventory's   -> the collector fetches a
 *     different OCI identity than the one this repo publishes.
 *
 * This check replaces the retired connector-sources and collector-packaging-manifest legs,
 * which compared vendored source copies and a tsconfig compile list. data-connect#248 removed
 * both of those layouts on purpose.
 *
 * Rules (every violation is reported, not just the first):
 *   a. A registry connector that is publishable has exactly one pin, with the inventory's
 *      connectorKey.
 *   b. A registry connector that is excluded from publishing has NO pin: there is no release
 *      to install. This is printed as a note with the exclusion reason, not a failure.
 *   c. A registry connector in neither list is not in the publish inventory: failure.
 *   d. A pin whose connectorId is not in the registry: failure.
 *   e. Two pins for one connectorId: failure.
 *
 * Deliberately NOT checked: versions, digests and ordering. data-connect verifies digests and
 * Sigstore signatures at install time, and a pin that lags the latest release is its own
 * choice.
 *
 * Usage:
 *   node check-collection-profile-pins-drift.mjs <data-connect-checkout> <data-connectors-checkout>
 *
 * Exit 0: the pins agree with the registry and the publish inventory.
 * Exit 1: drift detected, or an input file is missing.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Pure comparison; the CLI below only loads inputs and prints the result.
 *
 * @param {object} input
 * @param {ReadonlyArray<{connector_id: string}>} input.definitions registry entries
 * @param {ReadonlyArray<{manifest: string, connectorKey: string, exclusionReason: string | null}>} input.inventory
 *   the full publish inventory; `manifest` is the connector directory name, which equals the
 *   registry's connector_id. A null exclusionReason means publishable.
 * @param {ReadonlyArray<{connectorId: string, connectorKey: string}>} input.pins
 * @returns {{failures: string[], notes: string[]}}
 */
export function compareCollectionProfilePins({ definitions, inventory, pins }) {
	const failures = [];
	const notes = [];

	const registryIds = new Set(definitions.map((definition) => definition.connector_id));
	const inventoryById = new Map(inventory.map((entry) => [entry.manifest, entry]));
	const pinsById = new Map();
	for (const pin of pins) {
		pinsById.set(pin.connectorId, [...(pinsById.get(pin.connectorId) ?? []), pin]);
	}

	for (const id of registryIds) {
		const entry = inventoryById.get(id);
		const connectorPins = pinsById.get(id) ?? [];

		if (entry === undefined) {
			failures.push(`${id}: in the collector registry but not in the publish inventory (scripts/connector-publish-allowlist.mjs).`);
		} else if (entry.exclusionReason !== null) {
			if (connectorPins.length > 0) {
				failures.push(`${id}: excluded from publishing (${entry.exclusionReason}) but data-connect pins it; there is no release to install.`);
			} else {
				notes.push(`${id}: excluded from publishing and correctly unpinned (${entry.exclusionReason})`);
			}
		} else if (connectorPins.length === 0) {
			failures.push(`${id}: publishable and in the collector registry but data-connect has no Collection Profile pin for it.`);
		} else {
			for (const pin of connectorPins) {
				if (pin.connectorKey !== entry.connectorKey) {
					failures.push(`${id}: pinned connectorKey '${pin.connectorKey}' differs from the publish inventory's '${entry.connectorKey}'.`);
				}
			}
		}
	}

	for (const [id, connectorPins] of pinsById) {
		if (!registryIds.has(id)) {
			failures.push(`${id}: pinned by data-connect but not declared in the collector registry.`);
		}
		if (connectorPins.length > 1) {
			failures.push(`${id}: pinned ${connectorPins.length} times; each connector must have exactly one pin.`);
		}
	}

	return { failures, notes };
}

async function main() {
	const [, , dataConnectDir, dataConnectorsDir] = process.argv;

	if (!dataConnectDir || !dataConnectorsDir) {
		console.error("usage: check-collection-profile-pins-drift.mjs <data-connect-checkout> <data-connectors-checkout>");
		process.exit(1);
	}

	const pinsPath = join(dataConnectDir, "packages/local-collector/src/generated/collection-profile-pins.generated.ts");
	const registryPath = join(dataConnectorsDir, "packages/polyfill-connectors/src/collector-registry.ts");
	const allowlistPath = join(dataConnectorsDir, "scripts/connector-publish-allowlist.mjs");

	for (const [label, path] of [
		["data-connect Collection Profile pins", pinsPath],
		["data-connectors canonical collector-registry.ts", registryPath],
		["data-connectors connector-publish-allowlist.mjs", allowlistPath],
	]) {
		if (!existsSync(path)) {
			console.error(`FAIL: ${label} not found at ${path}`);
			process.exit(1);
		}
	}

	// The pins file and the registry are TypeScript. Node 24 strips their types on import;
	// the pins file's only import is type-only, and the registry's other imports are
	// relative paths inside this checkout, so neither needs an install step. This is the
	// same no-node_modules property check-collector-definitions-drift.mjs relies on.
	// pathToFileURL (not a `file://` template literal): the checkout paths arrive as CLI
	// arguments and may be relative, which would otherwise be misparsed as a URL *host*.
	const { COLLECTION_PROFILE_PINS } = await import(pathToFileURL(resolve(pinsPath)).href);
	const { LOCAL_COLLECTOR_DEFINITIONS } = await import(pathToFileURL(resolve(registryPath)).href);
	const { CONNECTOR_PUBLISH_INVENTORY } = await import(pathToFileURL(resolve(allowlistPath)).href);

	for (const [name, value, path] of [
		["COLLECTION_PROFILE_PINS", COLLECTION_PROFILE_PINS, pinsPath],
		["LOCAL_COLLECTOR_DEFINITIONS", LOCAL_COLLECTOR_DEFINITIONS, registryPath],
		["CONNECTOR_PUBLISH_INVENTORY", CONNECTOR_PUBLISH_INVENTORY, allowlistPath],
	]) {
		if (!Array.isArray(value) || value.length === 0) {
			console.error(`FAIL: ${path} exported no ${name} entries.`);
			process.exit(1);
		}
	}

	const { failures, notes } = compareCollectionProfilePins({
		definitions: LOCAL_COLLECTOR_DEFINITIONS,
		inventory: CONNECTOR_PUBLISH_INVENTORY,
		pins: COLLECTION_PROFILE_PINS,
	});

	for (const note of notes) {
		console.log(`NOTE: ${note}`);
	}

	if (failures.length > 0) {
		console.error("FAIL: data-connect's Collection Profile pins drifted from this repo's registry and publish inventory.");
		for (const failure of failures) {
			console.error(`  - ${failure}`);
		}
		console.error(`  data-connect pins:        ${pinsPath}`);
		console.error(`  data-connectors registry: ${registryPath}`);
		console.error(`  publish inventory:        ${allowlistPath}`);
		process.exit(1);
	}

	console.log(
		`OK: ${COLLECTION_PROFILE_PINS.length} Collection Profile pins match the ${LOCAL_COLLECTOR_DEFINITIONS.length} registry connectors (${notes.length} excluded from publishing and unpinned).`,
	);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	await main();
}
