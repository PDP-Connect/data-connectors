// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

export type InventoryEntity =
	| "orders"
	| "order_items"
	| "profile"
	| "addresses"
	| "nutrition";

/** Evidence belongs to one authenticated owner and one coherent source response.
 * Counts of units, max page links and layout observations are not list signals.
 * Current retained H-E-B captures expose no verified owner-bound list signal;
 * callers must leave those fields null rather than manufacture one.
 */
export interface InventoryEvidence {
	entity: InventoryEntity;
	ownerIdentity: string | null;
	signedInOwnerIdentity: string | null;
	requestedResource: string;
	landedResource: string;
	snapshotId: string | null;
	responseSucceeded: boolean | null;
	loading: boolean;
	coherent: boolean;
	sourceIds: string[];
	acceptedIds: string[];
	rejectedRows: number;
	missingIdentityRows: number;
	signal:
		| { entity: InventoryEntity; exactTotal: number }
		| { entity: InventoryEntity; explicitEnd: true }
		| null;
}

export function inventoryIsComplete(e: InventoryEvidence | undefined): boolean {
	if (
		!e ||
		!e.ownerIdentity ||
		e.ownerIdentity !== e.signedInOwnerIdentity ||
		!e.snapshotId ||
		!e.requestedResource ||
		e.requestedResource !== e.landedResource ||
		e.responseSucceeded !== true ||
		e.loading ||
		!e.coherent ||
		e.rejectedRows !== 0 ||
		e.missingIdentityRows !== 0 ||
		!e.signal ||
		e.signal.entity !== e.entity
	)
		return false;
	const source = new Set(e.sourceIds);
	const accepted = new Set(e.acceptedIds);
	if (
		source.size !== e.sourceIds.length ||
		accepted.size !== e.acceptedIds.length ||
		source.size !== accepted.size ||
		[...source].some((id) => !id || !accepted.has(id))
	)
		return false;
	return "explicitEnd" in e.signal
		? e.signal.explicitEnd === true
		: Number.isSafeInteger(e.signal.exactTotal) &&
				e.signal.exactTotal >= 0 &&
				e.signal.exactTotal === source.size;
}

export function unprovenInventory(
	entity: InventoryEntity,
	requestedResource: string,
	landedResource: string,
	html: string,
	sourceIds: string[] = [],
): InventoryEvidence {
	return {
		entity,
		requestedResource,
		landedResource,
		// A content digest identifies this observation, not a provider completion token.
		snapshotId: html ? createHash("sha256").update(html).digest("hex") : null,
		ownerIdentity: null,
		signedInOwnerIdentity: null,
		responseSucceeded: null,
		loading: /(?:aria-busy|data-loading)\s*=\s*["']true["']/i.test(html),
		coherent: false,
		sourceIds,
		acceptedIds: [],
		rejectedRows: 0,
		missingIdentityRows: 0,
		signal: null,
	};
}
