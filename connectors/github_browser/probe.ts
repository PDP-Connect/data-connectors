// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Page } from "playwright";
import { parseLoggedInUsername } from "./parsers.ts";

export async function probeGitHubBrowserSession(page: Page): Promise<boolean> {
	const response = await page.context().request.get("https://github.com/", {
		timeout: 10_000,
	});
	try {
		return parseLoggedInUsername(await response.text()) !== null;
	} finally {
		await response.dispose();
	}
}
