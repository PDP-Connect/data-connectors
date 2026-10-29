// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// LinkedIn decorated profile reads whose bodies do not parse, with the basic
// profile answering, on the real connector runtime. Run only as a test
// subprocess.
import type { Page } from "playwright";
import {
	type BrowserCollectContext,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { collectLinkedIn } from "./index.ts";
import { validateRecord } from "./schemas.ts";

const ME = { miniProfile: { publicIdentifier: "jamielee" } };
const BASIC_PROFILE = {
	elements: [{ firstName: "Anon", lastName: "Member" }],
};

const respond = (body: unknown) =>
	Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

/** A Voyager page for page.evaluate. voyagerFetch runs its closure inside the
 *  page, so the closure's globals are shimmed for the call, as in
 *  integration.test.ts. */
function voyagerPage(): Page {
	const fetchVoyager = (path: string) => {
		if (path.includes("decorationId=")) {
			return Promise.resolve({
				ok: true,
				status: 200,
				json: () =>
					Promise.reject(
						new SyntaxError(
							"Unexpected token 'S', \"SECRET_NOTE\" is not valid JSON",
						),
					),
			});
		}
		if (path.includes("memberIdentity=")) return respond(BASIC_PROFILE);
		if (path === "/voyager/api/me") return respond(ME);
		return Promise.resolve({
			ok: false,
			status: 404,
			json: () => Promise.resolve(null),
		});
	};
	const evaluate = async (fn: unknown, arg: unknown) => {
		const g = globalThis as { document?: unknown; fetch?: unknown };
		const prior = { document: g.document, fetch: g.fetch };
		g.document = { cookie: 'JSESSIONID="ajax:1234567890"' };
		g.fetch = fetchVoyager;
		try {
			return await (fn as (a: unknown) => unknown)(arg);
		} finally {
			g.document = prior.document;
			g.fetch = prior.fetch;
		}
	};
	return Object.assign({} as Page, { evaluate, goto: async () => null });
}

runConnector({
	name: "linkedin_synthetic_runtime",
	validateRecord,
	async collect(ctx) {
		await collectLinkedIn({
			...ctx,
			page: voyagerPage(),
		} as BrowserCollectContext);
	},
});
