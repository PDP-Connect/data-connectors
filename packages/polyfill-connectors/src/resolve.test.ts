// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { readPolyfillManifests } from "./manifest-registry.ts";
import {
	ConnectorImplementationNotFoundError,
	resolveConnectorImplementation,
} from "./resolve.ts";

function connectorId(manifest: unknown, file: string): string {
	if (
		typeof manifest !== "object" ||
		manifest === null ||
		!("connector_id" in manifest) ||
		typeof manifest.connector_id !== "string"
	) {
		throw new TypeError(`${file} must declare a string connector_id`);
	}
	return manifest.connector_id;
}

test("every shipped manifest resolves to its built connector entry", () => {
	for (const { file, manifest } of readPolyfillManifests()) {
		const id = connectorId(manifest, file);
		const implementation = resolveConnectorImplementation(id);
		assert.match(implementation.entry, /^file:\/\//);
		assert.match(implementation.brandIcon, /^file:\/\//);
		assert.equal(implementation.manifest.connector_id, id);
	}
});

test("an unknown connector ID has an actionable typed error", () => {
	assert.throws(
		() =>
			resolveConnectorImplementation(
				"https://registry.pdpp.dev/connectors/missing",
			),
		(error: unknown) =>
			error instanceof ConnectorImplementationNotFoundError &&
			error.code === "ERR_PDPP_CONNECTOR_IMPLEMENTATION_NOT_FOUND" &&
			error.message.includes("https://registry.pdpp.dev/connectors/missing"),
	);
});
