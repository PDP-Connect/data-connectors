// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { walkPagesWithCeiling } from "./page-ceiling.ts";

test("walkPagesWithCeiling distinguishes terminal exhaustion from a capped continuation", async () => {
	const completedPages: number[] = [];
	const complete = await walkPagesWithCeiling({
		maxPages: 2,
		fetchPage: (pageNumber) => {
			completedPages.push(pageNumber);
			return pageNumber < 2;
		},
	});
	assert.deepEqual(complete, { pagesFetched: 2, truncated: false });
	assert.deepEqual(completedPages, [1, 2]);

	const cappedPages: number[] = [];
	const capped = await walkPagesWithCeiling({
		maxPages: 2,
		fetchPage: (pageNumber) => {
			cappedPages.push(pageNumber);
			return true;
		},
	});
	assert.deepEqual(capped, { pagesFetched: 2, truncated: true });
	assert.deepEqual(cappedPages, [1, 2]);
});

test("an unlimited walk completes only at the terminal page", async () => {
	let lastPage = 0;
	const complete = await walkPagesWithCeiling({
		maxPages: Number.POSITIVE_INFINITY,
		fetchPage: (pageNumber) => {
			assert.equal(pageNumber, ++lastPage);
			return pageNumber <= 500;
		},
	});
	assert.equal(lastPage, 501);
	assert.deepEqual(complete, { pagesFetched: 501, truncated: false });
});

test("invalid finite ceilings still reject before fetching", async () => {
	for (const maxPages of [0, -1, 1.5, Number.NaN, Number.NEGATIVE_INFINITY]) {
		await assert.rejects(
			walkPagesWithCeiling({
				maxPages,
				fetchPage: () => assert.fail("invalid ceiling fetched a page"),
			}),
			RangeError,
		);
	}
});
