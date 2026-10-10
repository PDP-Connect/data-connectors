// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Page } from "playwright";
import { trackRunOwnedPages } from "./run-owned-pages.ts";

interface FakePage {
	closeCalls: () => number;
	openPopup: (popup: Page) => void;
	page: Page;
}

/**
 * A page whose `close()` stays pending until `beforeClosed` resolves. Only the
 * members `trackRunOwnedPages` touches are implemented.
 */
function makeFakePage(
	beforeClosed?: (self: FakePage) => Promise<void>,
): FakePage {
	const events = new EventEmitter();
	let closed = false;
	let closeCalls = 0;
	const fake = {
		close: async (): Promise<void> => {
			closeCalls += 1;
			await beforeClosed?.(result);
			closed = true;
		},
		isClosed: (): boolean => closed,
		off: (event: string, listener: (popup: Page) => void) => {
			events.off(event, listener);
			return fake;
		},
		on: (event: string, listener: (popup: Page) => void) => {
			events.on(event, listener);
			return fake;
		},
	};
	const result: FakePage = {
		closeCalls: () => closeCalls,
		openPopup: (popup) => {
			events.emit("popup", popup);
		},
		// The fake implements only what the tracker calls; Page's full surface
		// is irrelevant here.
		page: fake as Partial<Page> as Page,
	};
	return result;
}

test("a popup an owned page opens while its close is pending is closed too", async () => {
	const popup = makeFakePage();
	const opener = makeFakePage(async (self) => {
		// The page fires one more popup before its close lands.
		self.openPopup(popup.page);
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
	const runPages = trackRunOwnedPages();
	runPages.adopt(opener.page);

	const closed = await runPages.close();
	runPages.dispose();

	assert.equal(runPages.owns(popup.page), true, "the late popup was adopted");
	assert.equal(popup.page.isClosed(), true, "the late popup was closed");
	assert.equal(opener.page.isClosed(), true);
	assert.equal(closed, 2);
	assert.equal(opener.closeCalls(), 1, "a closed page is not closed again");
	assert.deepEqual(runPages.open(), []);
});

test("close skips the excepted page and stops after a bounded number of passes", async () => {
	const keep = makeFakePage();
	// Every page this chain closes opens another popup before closing, forever.
	const spawnChain = (): FakePage =>
		makeFakePage(async (self) => {
			self.openPopup(spawnChain().page);
		});
	const runPages = trackRunOwnedPages();
	runPages.adopt(keep.page);
	runPages.adopt(spawnChain().page);

	const closed = await runPages.close({ except: keep.page });
	runPages.dispose();

	assert.equal(keep.closeCalls(), 0, "the excepted page is never closed");
	assert.equal(closed, 5, "one chain page per pass, five passes at most");
	assert.equal(runPages.open().length, 2, "kept page + one unclosed popup");
});
