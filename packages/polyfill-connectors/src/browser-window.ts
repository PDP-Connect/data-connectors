// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Page } from "playwright";

export const BROWSER_MINIMIZE_AFTER_AUTH_ENV =
	"PDPP_BROWSER_MINIMIZE_AFTER_AUTH";

async function setBrowserWindowState(
	page: Page,
	state: "minimized" | "normal",
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	if (env[BROWSER_MINIMIZE_AFTER_AUTH_ENV] !== "1" || page.isClosed()) return;

	const context = page.context();
	const browser = context.browser();
	if (!browser) return;

	let targetSession:
		| Awaited<ReturnType<typeof context.newCDPSession>>
		| undefined;
	let browserSession:
		| Awaited<ReturnType<typeof browser.newBrowserCDPSession>>
		| undefined;
	try {
		targetSession = await context.newCDPSession(page);
		const target = (await targetSession.send("Target.getTargetInfo")) as {
			targetInfo?: { targetId?: string };
		};
		const targetId = target.targetInfo?.targetId;
		if (!targetId) return;

		browserSession = await browser.newBrowserCDPSession();
		const window = (await browserSession.send("Browser.getWindowForTarget", {
			targetId,
		})) as { windowId?: number };
		if (typeof window.windowId !== "number") return;

		await browserSession.send("Browser.setWindowBounds", {
			windowId: window.windowId,
			bounds: { windowState: state },
		});
	} catch {
		// Browser window control is best-effort. Unsupported headless or remote
		// surfaces must not turn a valid collection into a failed run.
	} finally {
		await browserSession?.detach().catch((): undefined => undefined);
		await targetSession?.detach().catch((): undefined => undefined);
	}
}

export function minimizeBrowserWindow(
	page: Page,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	return setBrowserWindowState(page, "minimized", env);
}

export function restoreBrowserWindow(
	page: Page,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	return setBrowserWindowState(page, "normal", env);
}
