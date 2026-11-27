/** Interpret Amazon's human status labels, not return-eligibility controls. */
const ORDER_COMPLETE = /^(?:refunded|refund issued|return complete)[.!]?$/i;
const ITEM_COMPLETE =
	/\b(?:refunded|refund issued|return complete|returned)\b/i;
// These item labels describe an incomplete return or an adjustment, not a
// completed item return. They also override a conflicting order label.
const NEGATED_COMPLETE =
	/\b(?:not|no|never)\s+(?:\w+\s+)?(?:refunded|refund issued|return complete|returned)\b|\b(?:not|never)\s+(?:been\s+)?picked up and returned\b/i;
export const RETURN_MODAL_BE_PATTERN = String.raw`\b(?:will|may|can|could|should|would|might|must|to)\s+(?:\w+\s+)?be`;
const FUTURE_COMPLETE = new RegExp(
	String.raw`${RETURN_MODAL_BE_PATTERN}\s+(?:returned|refunded)\b|\brefund\s+${RETURN_MODAL_BE_PATTERN}\s+issued\b`,
	"i",
);
const SHIPPING_ONLY =
	/\b(?:shipping|postage)(?:\s+(?:fee|charge|cost))?\s+only\b|\b(?:refunded|refund issued)(?:\s+for)?\s+(?:the\s+)?(?:shipping|postage)\b/i;
const PENDING_ITEM =
	/\b(?:return|refund)\s+(?:requested|started|pending|in progress|scheduled|initiated|authorized)\b/i;

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
	const itemIncomplete = item !== null &&
		(NEGATED_COMPLETE.test(item) || FUTURE_COMPLETE.test(item) || SHIPPING_ONLY.test(item));
	if (item && ITEM_COMPLETE.test(item) && !itemIncomplete) {
		return { returned: true, refund_status: item };
	}
	const itemPending = item !== null && PENDING_ITEM.test(item);
	// An attributable order label is fallback evidence, not an override for an item status.
	if (!itemIncomplete && !itemPending && itemCount === 1 && order && ORDER_COMPLETE.test(order)) {
		return { returned: true, refund_status: order };
	}
	return { returned: false, refund_status: item ?? (itemCount === 1 ? order : null) };
}
