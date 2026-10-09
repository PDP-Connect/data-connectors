// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Which browser pages belong to a connector run.
 *
 * A run owns the pages it creates (through the tracked context's `newPage()`,
 * or handed to `adopt()`) and every popup one of those pages opens, followed
 * through popups of popups. Ownership comes from the page's own `popup` event,
 * which Playwright fires only for pages whose opener is that page. It is never
 * inferred from membership in the browser context: in an attached browser
 * (`PDPP_<NAME>_REMOTE_CDP_URL`) the person who owns that browser can open a
 * tab at any time, and that tab lands in the same context as ours.
 */

import type { BrowserContext, Page } from "playwright";

export interface RunOwnedPages {
	/** Mark a page as run-owned and follow its popups. */
	adopt: (page: Page) => void;
	/**
	 * Close every open run-owned page except `except`. Each close is bounded so
	 * a wedged renderer cannot hang teardown; failures are swallowed because
	 * cleanup must never mask a run's real outcome. Resolves to the number of
	 * pages that closed.
	 */
	close: (options?: { except?: Page }) => Promise<number>;
	/** Stop following popups and restore the context's own `newPage`. */
	dispose: () => void;
	/** Run-owned pages that are still open, in the order they were adopted. */
	open: () => Page[];
	owns: (page: Page) => boolean;
}

const OWNED_PAGE_CLOSE_DEADLINE_MS = 10_000;

async function closePageBounded(
	page: Pick<Page, "close" | "isClosed">,
	deadlineMs: number,
): Promise<boolean> {
	if (page.isClosed()) {
		return false;
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const closed = await Promise.race([
			page.close().then(() => true),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => {
					process.stderr.write(
						`[browser-runtime] page.close() exceeded ${String(deadlineMs)}ms (wedged renderer?); abandoning close.\n`,
					);
					resolve(false);
				}, deadlineMs);
			}),
		]);
		return closed;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Start tracking run-owned pages. When `context` is given, pages it creates
 * through `newPage()` are adopted automatically; `dispose()` restores the
 * original `newPage` if nobody replaced it in the meantime.
 */
export function trackRunOwnedPages(
	context?: Pick<BrowserContext, "newPage">,
	deadlineMs = OWNED_PAGE_CLOSE_DEADLINE_MS,
): RunOwnedPages {
	const owned = new Set<Page>();
	const listeners = new Map<Page, (popup: Page) => void>();

	const adopt = (page: Page): void => {
		if (owned.has(page)) {
			return;
		}
		owned.add(page);
		const onPopup = (popup: Page): void => {
			adopt(popup);
		};
		listeners.set(page, onPopup);
		page.on("popup", onPopup);
	};

	let restoreNewPage: (() => void) | null = null;
	if (context) {
		const originalNewPage = context.newPage;
		const trackedNewPage: BrowserContext["newPage"] = async (...args) => {
			const page = await originalNewPage.apply(context, args);
			adopt(page);
			return page;
		};
		context.newPage = trackedNewPage;
		restoreNewPage = (): void => {
			if (context.newPage === trackedNewPage) {
				context.newPage = originalNewPage;
			}
		};
	}

	return {
		adopt,
		close: async ({ except } = {}) => {
			const targets = [...owned].filter(
				(page) => page !== except && !page.isClosed(),
			);
			const results = await Promise.all(
				targets.map((page) => closePageBounded(page, deadlineMs)),
			);
			return results.filter(Boolean).length;
		},
		dispose: () => {
			for (const [page, onPopup] of listeners) {
				page.off("popup", onPopup);
			}
			listeners.clear();
			restoreNewPage?.();
			restoreNewPage = null;
		},
		open: () => [...owned].filter((page) => !page.isClosed()),
		owns: (page) => owned.has(page),
	};
}
