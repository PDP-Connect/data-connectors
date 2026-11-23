// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Walk a paginated source without confusing a safety ceiling with a terminal
 * page. `fetchPage` performs the fetch and processing for one page, then
 * returns whether the provider says another page is available.
 *
 * The callback is allowed to return `true` on the final permitted page. That
 * is the important case: the provider still has unread data, so the result
 * must be marked truncated rather than complete. Positive Infinity lets a
 * caller with its own progress guard continue until a terminal page.
 */
export async function walkPagesWithCeiling(args: {
	readonly maxPages: number;
	readonly fetchPage: (pageNumber: number) => boolean | Promise<boolean>;
}): Promise<{ pagesFetched: number; truncated: boolean }> {
	if (
		args.maxPages !== Number.POSITIVE_INFINITY &&
		(!Number.isInteger(args.maxPages) || args.maxPages < 1)
	) {
		throw new RangeError(
			"maxPages must be a positive integer or positive Infinity",
		);
	}

	for (let pageNumber = 1; pageNumber <= args.maxPages; pageNumber += 1) {
		const hasMorePages = await args.fetchPage(pageNumber);
		if (!hasMorePages) {
			return { pagesFetched: pageNumber, truncated: false };
		}
	}

	return { pagesFetched: args.maxPages, truncated: true };
}
