// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const MACOS_BROWSER_EXECUTABLES: Readonly<Record<string, string>> = {
	chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"chrome-beta":
		"/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
	"chrome-dev":
		"/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev",
	"chrome-canary":
		"/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
	msedge: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"msedge-beta":
		"/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta",
	"msedge-dev":
		"/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev",
	"msedge-canary":
		"/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary",
};

export const MACOS_CHROME_GUIDANCE =
	"Install or update Google Chrome in /Applications, then retry. Open Chrome > About Google Chrome to check for updates.";

export function selectedLocalBrowserChannel(
	env: Record<string, string | undefined>,
	platform: NodeJS.Platform,
): string | undefined {
	return (
		env.PDPP_BROWSER_CHANNEL?.trim() ||
		(platform === "darwin" ? "chrome" : undefined)
	);
}

export function macosBrowserExecutable(channel: string): string | undefined {
	return Object.hasOwn(MACOS_BROWSER_EXECUTABLES, channel)
		? MACOS_BROWSER_EXECUTABLES[channel]
		: undefined;
}
