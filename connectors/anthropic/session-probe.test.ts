// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import {
	ANTHROPIC_BROWSER_LOGIN_ASSISTANCE_MESSAGE,
	ensureAnthropicSession,
	probeAnthropicSession,
} from "./index.ts";

function makeArgs(
	cookies: Array<{ name: string; value: string }>,
	goto?: () => Promise<unknown>,
) {
	const navigations: Array<{ url: string; options: unknown }> = [];
	return {
		navigations,
		args: {
			context: { cookies: async () => cookies },
			page: {
				goto: async (url: string, options: unknown) => {
					navigations.push({ url, options });
					return goto?.();
				},
			},
		} as never,
	};
}

test("dead Claude cookie probe opens login origin for manual handoff", async () => {
	const { args, navigations } = makeArgs([]);
	assert.equal(await probeAnthropicSession(args), false);
	assert.deepEqual(navigations, [
		{
			url: "https://claude.ai/new",
			options: { waitUntil: "domcontentloaded" },
		},
	]);
});

test("Claude login-origin navigation failure propagates", async () => {
	const failure = new Error("navigation failed");
	const { args, navigations } = makeArgs([], async () => {
		throw failure;
	});
	await assert.rejects(
		probeAnthropicSession(args),
		(error) => error === failure,
	);
	assert.equal(navigations.length, 1);
});

test("live Claude cookie probe leaves the current page alone", async () => {
	const { args, navigations } = makeArgs([
		{ name: "sessionKey", value: "synthetic" },
	]);
	assert.equal(await probeAnthropicSession(args), true);
	assert.deepEqual(navigations, []);
});

test("Claude manual login handoff auto-resumes when readiness probe sees a live session", async () => {
	let readinessProbeCount = 0;
	const assistance: unknown[] = [];
	const completions: unknown[] = [];
	const interactions: unknown[] = [];
	const handoffPage = makePageWithReadinessPages(() => {
		readinessProbeCount += 1;
		return readinessProbeCount >= 2
			? [{ name: "sessionKey", value: "synthetic" }]
			: [];
	});

	await ensureAnthropicSession({
		assist: (request) => {
			assistance.push(request);
			return Promise.resolve("assist-1");
		},
		autoProbeIntervalMs: 0,
		autoProbeWindowMs: 10_000,
		capture: null,
		completeAssistance: (id, status, extra) => {
			completions.push({ extra, id, status });
			return Promise.resolve();
		},
		context: handoffPage.context(),
		now: () => 0,
		page: handoffPage,
		sendInteraction: (request) => {
			interactions.push(request);
			return Promise.resolve({ kind: "manual_action", data: {} } as never);
		},
	});

	assert.equal(readinessProbeCount, 2);
	assert.equal(handoffPage.openedReadinessPages, 0);
	assert.deepEqual(handoffPage.navigations, []);
	assert.equal(interactions.length, 0);
	assert.deepEqual(assistance, [
		{
			attachments: [{ kind: "browser_surface", role: "streaming_companion" }],
			message: ANTHROPIC_BROWSER_LOGIN_ASSISTANCE_MESSAGE,
			owner_action: "operate_attachment",
			progress_posture: "blocked",
			response_contract: "none",
			timeout_seconds: 1800,
		},
	]);
	assert.deepEqual(completions, [
		{
			extra: {
				message:
					"The connector detected the session was ready and continued automatically.",
			},
			id: "assist-1",
			status: "resolved",
		},
	]);
});

test("Claude manual login handoff fails closed when readiness never appears", async () => {
	const completions: unknown[] = [];
	const handoffPage = makePageWithReadinessPages(() => []);

	await assert.rejects(
		ensureAnthropicSession({
			assist: () => Promise.resolve("assist-1"),
			autoProbeIntervalMs: 0,
			autoProbeWindowMs: 0,
			capture: null,
			completeAssistance: (id, status, extra) => {
				completions.push({ extra, id, status });
				return Promise.resolve();
			},
			context: handoffPage.context(),
			now: () => 0,
			page: handoffPage,
			sendInteraction: () =>
				Promise.resolve({ kind: "manual_action", data: {} } as never),
		}),
		/browser_handoff_readiness_timed_out/u,
	);

	assert.deepEqual(completions, [
		{
			extra: {
				message:
					"Browser sign-in did not become ready before the handoff timed out.",
			},
			id: "assist-1",
			status: "escalated",
		},
	]);
});

function makePageWithReadinessPages(
	readinessCookies: () => Array<{ name: string; value: string }>,
): Page & { navigations: string[]; openedReadinessPages: number } {
	const page = makePage(readinessCookies, () =>
		makePage(readinessCookies),
	) as Page & {
		navigations: string[];
		openedReadinessPages: number;
	};
	page.navigations = [];
	page.openedReadinessPages = 0;
	const context = page.context;
	page.context = () => {
		const base = context();
		return {
			...base,
			newPage: async () => {
				page.openedReadinessPages += 1;
				return makePage(readinessCookies);
			},
		} as ReturnType<Page["context"]>;
	};
	const goto = page.goto;
	page.goto = async (url, options) => {
		page.navigations.push(String(url));
		return goto(url, options);
	};
	return page;
}

function makePage(
	cookies: () => Array<{ name: string; value: string }>,
	newPage?: () => Page,
): Page {
	const page = Object.create(null) as Page;
	page.close = () => Promise.resolve();
	page.context = () =>
		({
			cookies: () => Promise.resolve(cookies()),
			newPage: () => Promise.resolve(newPage?.() ?? makePage(cookies)),
		}) as ReturnType<Page["context"]>;
	page.goto = () => Promise.resolve(null);
	return page;
}
