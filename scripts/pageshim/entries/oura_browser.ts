// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { ensureOuraApiAccess, OURA_LOGIN_URL, probeOuraCachedApiAccess, probeOuraPortalSession, probeOuraSignInInProgress } from "../../../connectors/oura_browser/api-access.ts";
import { collectOuraBrowser } from "../../../connectors/oura_browser/index.ts";
import { validateRecord } from "../../../connectors/oura_browser/schemas.ts";
import { applyRequestedScopeEntries } from "../requested-scope-entries.ts";
import { runOnPageShim, type ShimPage } from "../runtime.ts";
import type { Page } from "playwright";

declare const PAGESHIM_CONNECTOR_VERSION: string;

const streams = ["sleep", "readiness", "activity"];

function requestedScopeEntries(page: ShimPage): unknown {
	try {
		return (page as ShimPage & { requestedScopeEntries?: () => unknown }).requestedScopeEntries?.();
	} catch { return undefined; }
}

function withOuraTokenPost(page: ShimPage, pw: Page): Page {
	return Object.assign(Object.create(pw) as Page, {
		context: () => {
			const context = pw.context();
			return {
				...context,
				request: {
					...context.request,
					post: async (url: string, options: { data?: string; headers?: Record<string, string> }) => {
						const result = await page.httpFetch(url, {
							method: "POST", headers: options.headers,
							body: options.data,
						});
						return {
							ok: () => result.ok,
							status: () => result.status,
							json: async () => result.json,
							text: async () => result.text,
							dispose: async () => {},
						};
					},
				},
			};
		},
	});
}

(globalThis as Record<string, unknown>).__pageshimMain = (
	page: ShimPage,
	initialState: Record<string, unknown>,
	supportsState: boolean,
) => runOnPageShim(page, {
	platform: "oura",
	scopes: streams.map((stream) => `oura.${stream}`),
	version: PAGESHIM_CONNECTOR_VERSION,
	loginUrl: OURA_LOGIN_URL,
	loginMessage: "Sign in to the Oura Developer Portal, then return here.",
	validateRecord,
	probe: async (pw) => Boolean(await probeOuraCachedApiAccess(withOuraTokenPost(page, pw as Page))) ||
		await probeOuraSignInInProgress(pw as Page) || await probeOuraPortalSession(pw as Page),
	prepareRequested: (requested) => applyRequestedScopeEntries(requested, requestedScopeEntries(page), "oura"),
	collect: async (ctx) => {
		const pw = withOuraTokenPost(page, ctx.page as Page);
		const access = await ensureOuraApiAccess(pw, async (url, message, ready) => {
			const current = await pw.evaluate(() => location.href).catch(() => "");
			await page.showBrowser(current === url ? undefined : url);
			if (current !== url)
				await pw.goto(url, { waitUntil: "domcontentloaded" });
			const completed = await page.promptUser(message, ready, 2000);
			if (!completed) throw new Error("oura_authorization_incomplete");
			await page.goHeadless();
		});
		await collectOuraBrowser(ctx as never, access);
	},
	toScope: (_stream, records) => ({ records }),
	emptyScopeFromCheckpoint: true,
	summarize: (scopes) => {
		const counts = Object.fromEntries(streams.map((stream) => [
			stream,
			(scopes[`oura.${stream}`] as { records?: unknown[] } | undefined)?.records?.length ?? 0,
		]));
		const count = Object.values(counts).reduce((sum, value) => sum + value, 0);
		return { count, label: count === 1 ? "record" : "records", details: counts };
	},
}, initialState, supportsState);
