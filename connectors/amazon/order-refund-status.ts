/** Interpret Amazon's human status labels, not return-eligibility controls. */
const ORDER_COMPLETE = /^(?:refunded|refund issued|return complete)[.!]?$/i;
const ITEM_COMPLETE =
	/\b(?:refunded|refund issued|return complete|returned)\b/i;
// A negation before the phrase, with at most one word between ("Not returned",
// "No refund issued", "Not yet refunded"), means it has not happened.
const NEGATED_COMPLETE =
	/\b(?:not|no|never)\s+(?:\w+\s+)?(?:refunded|refund issued|return complete|returned)\b/i;
// Eligibility controls say what a buyer may still do, not what happened.
const ELIGIBILITY = /^\s*return (?:or replace items|window)/i;

function statusText(value: string | null | undefined): string | null {
	const text = value?.trim();
	return text && !/<[^>]*>/.test(text) ? text : null;
}

export function deriveItemReturnState({
	itemRefundText,
	orderStatus,
	itemCount,
}: {
	itemRefundText: string | null | undefined;
	orderStatus: string | null | undefined;
	itemCount: number | null;
}): { returned: boolean; refund_status: string | null } {
	const item = statusText(itemRefundText);
	const order = statusText(orderStatus);
	if (item && ITEM_COMPLETE.test(item) && !NEGATED_COMPLETE.test(item)) {
		return { returned: true, refund_status: item };
	}
	const itemNegated = item !== null && NEGATED_COMPLETE.test(item);
	// An explicit "Not returned" on the item outranks the order-level label.
	if (!itemNegated && itemCount === 1 && order && ORDER_COMPLETE.test(order)) {
		return { returned: true, refund_status: order };
	}
	const itemInformative = item && !ELIGIBILITY.test(item) ? item : null;
	return {
		returned: false,
		refund_status:
			itemCount === 1 ? (item ?? order) : (itemInformative ?? order ?? item),
	};
}
