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
import type { BrowserPageObservation } from "./page-evidence.ts";
import { probeGitHubBrowserSession } from "./probe.ts";
import { validateRecord } from "./schemas.ts";

const CONTRIBUTION_CALENDAR_SELECTOR =
	"td.ContributionCalendar-day[data-date], rect.day[data-date]";
const CONTRIBUTION_CALENDAR_MINIMUM_DAYS = 365;
const CONTRIBUTION_CALENDAR_WAIT_TIMEOUT_MS = 8_000;

export async function openContributionPage(
	page: BrowserCollectContext["page"],
	url: string,
): Promise<BrowserPageObservation> {
	let navigated = false;
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			await page.goto(url, { waitUntil: "domcontentloaded" });
			navigated = true;
			break;
		} catch (error) {
			lastError = error;
		}
	}
	if (!navigated)
		throw lastError instanceof Error
			? lastError
			: new Error("github_browser_navigation_failed");
	try {
		const ready = await page.waitForFunction(
			({ minimumDays, selector }) =>
				Boolean(document.querySelector("h2#js-contribution-activity-description")) &&
				document.querySelectorAll(selector).length >= minimumDays,
			{
				minimumDays: CONTRIBUTION_CALENDAR_MINIMUM_DAYS,
				selector: CONTRIBUTION_CALENDAR_SELECTOR,
			},
			{ timeout: CONTRIBUTION_CALENDAR_WAIT_TIMEOUT_MS },
		);
		await ready.dispose();
	} catch {
		// Leave incomplete pages for the collector's completeness check to skip.
	}
	return {
		requestedUrl: url,
		currentUrl: page.url(),
		html: await page.content(),
	};
}

async function openGitHubPage(
	page: BrowserCollectContext["page"],
	url: string,
): Promise<BrowserPageObservation> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			await page.goto(url, { waitUntil: "domcontentloaded" });
			await page
				.waitForFunction(() => document.readyState === "complete", undefined, {
					timeout: 4_000,
				})
				.catch(() => undefined);
			return {
				requestedUrl: url,
				currentUrl: page.url(),
				html: await page.content(),
			};
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error("github_browser_navigation_failed");
}

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
		readinessProbeOnHandoffPage: true,
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
		fetchPublicJson: async (url: string) =>
			page.evaluate(async (target) => {
				const response = await fetch(target, {
					headers: {
						Accept: "application/vnd.github+json",
						"X-GitHub-Api-Version": "2022-11-28",
					},
				});
				if (!response.ok)
					throw new Error(`github_browser_http_${response.status}`);
				return {
					requestedUrl: target,
					responseUrl: response.url,
					status: response.status,
					data: await response.json(),
				};
			}, url),
		now: () => new Date(),
		openPage: async (url: string) => openGitHubPage(page, url),
		openContributionPage: async (url: string) =>
			openContributionPage(page, url),
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
