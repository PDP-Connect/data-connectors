// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { CONNECTOR_PUBLISH_INVENTORY } from "./connector-publish-allowlist.mjs";

const connectorsRoot = new URL("../connectors/", import.meta.url);

function readManifest(directory) {
	return JSON.parse(readFileSync(new URL(`${directory}/manifest.json`, connectorsRoot), "utf8"));
}

/**
 * The manifests whose artifacts carry the same source declaration as
 * `profile`: every publishable artifact that names the same `source.id`.
 * An excluded artifact is never published, so it declares its source alone;
 * that keeps a held artifact (for example the GitHub PAT connector, whose
 * streams conflict with github-browser's) out of the published declaration.
 */
export function sourceDeclarationMembers(profile) {
	const own = CONNECTOR_PUBLISH_INVENTORY.find(
		({ connectorKey }) => connectorKey === profile.connector_key,
	);
	if (!own || own.exclusionReason !== null) {
		return [profile];
	}
	return CONNECTOR_PUBLISH_INVENTORY.filter(({ exclusionReason }) => exclusionReason === null)
		.map(({ manifest, connectorKey }) =>
			connectorKey === profile.connector_key ? profile : readManifest(manifest),
		)
		.filter((manifest) => manifest.source?.id === profile.source?.id);
}
