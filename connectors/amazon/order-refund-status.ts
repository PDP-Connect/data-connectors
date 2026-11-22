/** Interpret Amazon's human status labels, not return-eligibility controls. */
const ORDER_COMPLETE = /^(?:refunded|refund issued|return complete)$/i;
const ITEM_COMPLETE =
	/\b(?:refunded|refund issued|return complete|returned)\b/i;

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
	if (item && ITEM_COMPLETE.test(item)) {
		return { returned: true, refund_status: item };
	}
	if (itemCount === 1 && order && ORDER_COMPLETE.test(order)) {
		return { returned: true, refund_status: order };
	}
	return {
		returned: false,
		refund_status: itemCount === 1 ? (item ?? order) : (order ?? item),
	};
}
