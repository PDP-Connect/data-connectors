// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import connectorIndex from "../connector-index.json" with { type: "json" };

export interface ConnectorImplementation {
	/** A file URL for the connector's brand icon in the installed package. */
	readonly brandIcon: string;
	/** A file URL for the built JavaScript implementation, safe for `import()`. */
	readonly entry: string;
	readonly manifest: Record<string, unknown>;
}

export class ConnectorImplementationNotFoundError extends Error {
	readonly code = "ERR_PDPP_CONNECTOR_IMPLEMENTATION_NOT_FOUND";

	constructor(connectorId: string) {
		super(`Unknown polyfill connector_id: ${connectorId}`);
		this.name = "ConnectorImplementationNotFoundError";
	}
}

const implementations = new Map(
	connectorIndex.connectors.map((implementation) => [
		implementation.connectorId,
		implementation,
	]),
);
const packageRootUrl = new URL("../", import.meta.url);

/**
 * Resolve a manifest connector ID without discovering connector files.
 *
 * `entry` and `brandIcon` are file URLs rooted in the installed package.
 * Consumers can call `await import(implementation.entry)` directly.
 */
export function resolveConnectorImplementation(
	connectorId: string,
): ConnectorImplementation {
	const implementation = implementations.get(connectorId);
	if (!implementation) {
		throw new ConnectorImplementationNotFoundError(connectorId);
	}
	return {
		brandIcon: new URL(implementation.brandIcon, packageRootUrl).href,
		entry: new URL(implementation.entry, packageRootUrl).href,
		manifest: implementation.manifest,
	};
}
