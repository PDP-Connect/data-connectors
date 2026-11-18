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
	/** Outermost source lines without a parsed product name link. */
	linklessLines?: number;
	/** One complete snapshot held exactly the source's line total, the parsed
	 * html still holds that many lines, and the server total did not change. */
	lineCountProven?: boolean;
	/** Source lines that own more than one product name link. */
	multiNameLines?: number;
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
		!e.signal ||
		e.signal.entity !== e.entity ||
		!rowsAreRead(e)
	)
		return false;
	const total = new Set(e.sourceIds).size;
	return "explicitEnd" in e.signal
		? e.signal.explicitEnd === true
		: Number.isSafeInteger(e.signal.exactTotal) &&
				e.signal.exactTotal >= 0 &&
				e.signal.exactTotal === total;
}

/** The signed-in session's server-rendered page for one order states how many
 * item lines it holds (account-source.ts sourceOrderItemTotal). Like the
 * server-rendered empty order history, that is account evidence without a
 * provider owner id: the payload names the requested order, and H-E-B serves
 * it only to the signed-in owner. Every row must still be read and accepted,
 * and the distinct rows must number exactly that total. */
export function inventoryMatchesSourceTotal(
	e: InventoryEvidence | undefined,
	sourceTotal: number | null,
): boolean {
	return (
		e !== undefined &&
		e.entity === "order_items" &&
		sourceTotal !== null &&
		Number.isSafeInteger(sourceTotal) &&
		sourceTotal > 0 &&
		e.lineCountProven === true &&
		rowsAreRead(e) &&
		new Set(e.sourceIds).size === sourceTotal
	);
}

/** One coherent, settled response for the requested resource, whose every
 * source row has an identity and was accepted. Not a completeness signal. */
function rowsAreRead(e: InventoryEvidence): boolean {
	if (
		!e.snapshotId ||
		!e.requestedResource ||
		e.requestedResource !== e.landedResource ||
		e.responseSucceeded !== true ||
		e.loading ||
		!e.coherent ||
		e.rejectedRows !== 0 ||
		e.missingIdentityRows !== 0 ||
		(e.linklessLines ?? 0) !== 0 ||
		(e.multiNameLines ?? 0) !== 0
	)
		return false;
	const source = new Set(e.sourceIds);
	const accepted = new Set(e.acceptedIds);
	return !(
		source.size !== e.sourceIds.length ||
		accepted.size !== e.acceptedIds.length ||
		source.size !== accepted.size ||
		[...source].some((id) => !id || !accepted.has(id))
	);
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
