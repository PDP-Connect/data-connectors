#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { isMainModule } from "@pdpp/connector-protocol";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import {
	type BrowserCollectContext,
	type EnsureSessionArgs,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { collectGitHubBrowser } from "./collector.ts";
import { probeGitHubBrowserSession } from "./probe.ts";
import { validateRecord } from "./schemas.ts";

async function ensureSession({
	assist,
	capture,
	completeAssistance,
	page,
	sendInteraction,
}: EnsureSessionArgs): Promise<void> {
	if (await probeGitHubBrowserSession(page)) return;
	await page.goto("https://github.com/login", {
		waitUntil: "domcontentloaded",
	});
	const ready = await manualBrowserLogin({
		assist,
		capture,
		completeAssistance,
		isProbeSuccessful: (result) => result === true,
		message:
			"Sign in to GitHub in the secure browser, then continue. PDPP will verify the session before collecting.",
		page,
		probe: () => probeGitHubBrowserSession(page),
		readinessProbe: (readinessPage) => probeGitHubBrowserSession(readinessPage),
		sendInteraction,
		timeoutSeconds: 30 * 60,
	});
	if (!ready) throw new Error("github_browser_session_missing");
}

export async function collect({
	emit,
	emitRecord,
	page,
	progress,
	requested,
	state,
}: Pick<
	BrowserCollectContext,
	"emit" | "emitRecord" | "page" | "progress" | "requested" | "state"
>): Promise<void> {
	const services = {
		fetchPublicJson: async (url: string): Promise<unknown> =>
			page.evaluate(async (target) => {
				const response = await fetch(target, {
					headers: { Accept: "application/vnd.github+json" },
				});
				if (!response.ok)
					throw new Error(`github_browser_http_${response.status}`);
				return await response.json();
			}, url),
		now: () => new Date(),
		openPage: async (url: string) => {
			await page.goto(url, { waitUntil: "domcontentloaded" });
			return await page.content();
		},
		sleep: async (ms: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, ms)),
	};
	await progress("Collecting the selected GitHub browser streams");
	await collectGitHubBrowser(
		{ emit, emitRecord, progress, requested: new Set(requested.keys()), state },
		services,
	);
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "github_browser",
		validateRecord,
		browser: { profileName: "github_browser" },
		ensureSession,
		probeSession: ({ page }) => probeGitHubBrowserSession(page),
		probeSessionIsAuthoritative: true,
		collect,
	});
}
