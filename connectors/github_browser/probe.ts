// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Page } from "playwright";
import { parseLoggedInUsername } from "./parsers.ts";

export async function probeGitHubBrowserSession(page: Page): Promise<boolean> {
	await page.goto("https://github.com/", { waitUntil: "domcontentloaded" });
	return parseLoggedInUsername(await page.content()) !== null;
}
