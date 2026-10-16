// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buildFullScanCoverageMessage, type EmittedMessage } from "../../packages/polyfill-connectors/src/connector-runtime.ts";

// TODO #418: replace this local compatibility helper with the shared runtime export.
/**
 * Full-inventory authority is supplied by the connector's source enumeration.
 * Counts alone never establish the complete flag. An incomplete aggregate must
 * be withheld by the caller before invoking this helper.
 */
export function fullInventoryCoverage(
	stream: string,
	enumeration: {
		kind: "enumerated";
		complete: boolean;
		considered: number;
		covered: number;
	},
): EmittedMessage {
	const { considered, covered } = enumeration;
	if (enumeration.kind === "enumerated" && enumeration.complete &&
		Number.isSafeInteger(considered) && considered >= 0 &&
		Number.isSafeInteger(covered) && covered === considered) {
		return buildFullScanCoverageMessage(stream, considered);
	}
	return {
		type: "SKIP_RESULT",
		stream,
		reason: "inventory_not_proven_complete",
		message: "Source enumeration did not prove the inventory complete.",
		recovery_hint: { action: "retry_by_runtime", retryable: true },
		diagnostics: { enumeration },
	};
}

