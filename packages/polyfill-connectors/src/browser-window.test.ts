// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import {
	BROWSER_MINIMIZE_AFTER_AUTH_ENV,
	minimizeBrowserWindow,
	restoreBrowserWindow,
} from "./browser-window.ts";

function makePage(commands: string[], fail = false): Page {
	const targetSession = {
		send: async (command: string) => {
			commands.push(command);
			if (command === "Target.getTargetInfo") {
				return { targetInfo: { targetId: "target-1" } };
			}
			return {};
		},
		detach: async () => undefined,
	} as CDPSession;
	const browserSession = {
		send: async (
			command: string,
			params?: { bounds?: { windowState?: string } },
		) => {
			commands.push(
				command === "Browser.setWindowBounds"
					? `${command}:${params?.bounds?.windowState}`
					: command,
			);
			if (fail) throw new Error("window control unavailable");
			if (command === "Browser.getWindowForTarget") return { windowId: 3 };
			return {};
		},
		detach: async () => undefined,
	} as CDPSession;
	const browser = {
		newBrowserCDPSession: async () => browserSession,
	} as Browser;
	const context = {
		browser: () => browser,
		newCDPSession: async () => targetSession,
	} as unknown as BrowserContext;
	return {
		context: () => context,
		isClosed: () => false,
	} as Page;
}

test("window minimization is opt-in and uses the existing browser window", async () => {
	const commands: string[] = [];
	const page = makePage(commands);
	await minimizeBrowserWindow(page, {});
	assert.deepEqual(commands, []);

	const env = { [BROWSER_MINIMIZE_AFTER_AUTH_ENV]: "1" };
	await minimizeBrowserWindow(page, env);
	await restoreBrowserWindow(page, env);
	assert.deepEqual(commands, [
		"Target.getTargetInfo",
		"Browser.getWindowForTarget",
		"Browser.setWindowBounds:minimized",
		"Target.getTargetInfo",
		"Browser.getWindowForTarget",
		"Browser.setWindowBounds:normal",
	]);
});

test("unsupported browser window control does not fail connector collection", async () => {
	const commands: string[] = [];
	await assert.doesNotReject(
		minimizeBrowserWindow(makePage(commands, true), {
			[BROWSER_MINIMIZE_AFTER_AUTH_ENV]: "1",
		}),
	);
	assert.deepEqual(commands, [
		"Target.getTargetInfo",
		"Browser.getWindowForTarget",
	]);
});
