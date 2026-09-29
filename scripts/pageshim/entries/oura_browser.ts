// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// oura_browser on PageShim. Each scope is `{ records }`, matching the stream's
// PDPP records.
import { collectOuraBrowser } from "../../../connectors/oura_browser/index.ts";
import { validateRecord } from "../../../connectors/oura_browser/schemas.ts";
import { runOnPageShim, type ShimPage } from "../runtime.ts";

// Defined by build.mjs from connectors/oura_browser/manifest.json.
declare const PAGESHIM_CONNECTOR_VERSION: string;

const scopes = ["sleep", "readiness", "activity"].map((s) => `oura.${s}`);

(globalThis as Record<string, unknown>).__pageshimMain = (page: ShimPage) =>
	runOnPageShim(page, {
		platform: "oura",
		scopes,
		version: PAGESHIM_CONNECTOR_VERSION,
		loginUrl: "https://cloud.ouraring.com/user/sign-in",
		loginMessage: "Sign in to Oura, then return here.",
		validateRecord,
		probe: (pw) =>
			pw.evaluate(async () => {
				try {
					if (location.origin !== "https://cloud.ouraring.com") return false;
					return (await fetch("/api/me", { credentials: "include" })).ok;
				} catch {
					return false;
				}
			}) as Promise<boolean>,
		collect: (ctx) => collectOuraBrowser(ctx as never),
		toScope: (_stream, records) => ({ records }),
		summarize: (resultScopes) => {
			const count = (scope: string) =>
				(resultScopes[scope] as { records?: unknown[] } | undefined)?.records
					?.length ?? 0;
			const sleep = count("oura.sleep");
			const readiness = count("oura.readiness");
			const activity = count("oura.activity");
			const total = sleep + readiness + activity;
			return {
				count: total,
				label: total === 1 ? "record" : "records",
				details: { sleep, readiness, activity },
			};
		},
	});
