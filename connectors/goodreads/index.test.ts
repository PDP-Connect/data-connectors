// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { assertUserFacingProgress } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import {
	consentTimeFieldResolver,
	type EmittedMessage,
	makeEmitRecord,
	type StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { skipPoliteDelays } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { timeRangeUnsupportedReason } from "../../packages/polyfill-connectors/src/time-range.ts";
import type { GoodreadsCollectContext } from "./collector.ts";
import { collect, probeGoodreadsPage, probeGoodreadsSession } from "./index.ts";
import { validateRecord } from "./schemas.ts";

after(skipPoliteDelays());

const ORIGIN = "https://www.goodreads.com";
const UID = "90000001";
const fixture = (name: string): string =>
	readFileSync(new URL(`./fixtures/html/${name}`, import.meta.url), "utf8");
const manifest = JSON.parse(
	readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
) as { reason_display_messages: Record<string, string> };

interface SiteResponse {
	body: string;
	headers?: Record<string, string>;
	status?: number;
	url?: string;
}
/** A fake goodreads.com: `path` is what the connector fetched, `call` counts earlier calls to it. */
type Site = (path: string, call: number) => SiteResponse;

const PRINT_PAGES: Record<string, string> = {
	"1": fixture("library-page-1.html"),
	"2": fixture("library-page-2.html"),
};

const WAF_CHALLENGE: SiteResponse = {
	body: "",
	headers: { "x-amzn-waf-action": "challenge" },
	status: 202,
};

/** The default signed-in site: sidebar, two print pages, profile and settings. */
function signedInSite(overrides: Partial<Record<string, Site>> = {}): Site {
	return (path, call) => {
		const url = new URL(path, ORIGIN);
		const key =
			url.pathname === `/review/list/${UID}` && url.searchParams.has("print")
				? "print"
				: url.pathname === "/review/list"
					? "home"
					: url.pathname === `/user/show/${UID}`
						? "profile"
						: url.pathname === "/user/edit"
							? "settings"
							: "other";
		const override = overrides[key];
		if (override) return override(path, call);
		switch (key) {
			case "home":
				return {
					body: fixture("library-sidebar.html"),
					url: `${ORIGIN}/review/list/${UID}-synthetic-reader`,
				};
			case "print":
				return {
					body:
						PRINT_PAGES[url.searchParams.get("page") ?? ""] ??
						fixture("library-no-rows.html"),
				};
			case "profile":
				return { body: fixture("profile.html") };
			case "settings":
				return { body: fixture("settings.html") };
			default:
				return { body: "not found", status: 404 };
		}
	};
}

/** The signed-in home page with its sidebar changed by `edit`. */
const sidebarHome = (edit: (html: string) => string): SiteResponse => ({
	body: edit(fixture("library-sidebar.html")),
	url: `${ORIGIN}/review/list/${UID}-synthetic-reader`,
});

const signedOutSite: Site = () => ({
	body: fixture("signin.html"),
	url: `${ORIGIN}/user/sign_in?returnurl=%2Freview%2Flist`,
});

interface Harness {
	failures: { message: string; stream: string }[];
	messages: EmittedMessage[];
	paths: string[];
	progress: string[];
	records: { data: Record<string, unknown>; stream: string }[];
	visits: string[];
	ctx: GoodreadsCollectContext;
}

function harness(
	site: Site,
	requested: Record<string, Partial<StreamScope>>,
	onVisit?: (url: string) => void,
): Harness {
	const paths: string[] = [];
	const calls = new Map<string, number>();
	const visits: string[] = [];
	const state: Harness = {
		ctx: undefined as unknown as GoodreadsCollectContext,
		failures: [],
		messages: [],
		paths,
		progress: [],
		records: [],
		visits,
	};
	const fakeFetch = async (path: string) => {
		const call = calls.get(path) ?? 0;
		calls.set(path, call + 1);
		paths.push(path);
		const answer = site(path, call);
		return {
			headers: new Headers(answer.headers ?? {}),
			status: answer.status ?? 200,
			text: async () => answer.body,
			url: answer.url ?? new URL(path, ORIGIN).toString(),
		};
	};
	state.ctx = {
		emit: async (message) => {
			state.messages.push(message);
		},
		emitRecord: async (stream, data) => {
			const verdict = validateRecord(stream, data);
			assert.equal(
				verdict.ok,
				true,
				`${stream} record is valid: ${JSON.stringify(verdict)}`,
			);
			state.records.push({ data: data as Record<string, unknown>, stream });
		},
		page: {
			evaluate: (async (fn: (arg: unknown) => unknown, arg: unknown) => {
				const saved = {
					fetch: globalThis.fetch,
					location: Object.getOwnPropertyDescriptor(globalThis, "location"),
				};
				Object.defineProperty(globalThis, "location", {
					configurable: true,
					value: { origin: ORIGIN },
				});
				globalThis.fetch = fakeFetch as unknown as typeof fetch;
				try {
					return await fn(arg);
				} finally {
					globalThis.fetch = saved.fetch;
					if (saved.location) {
						Object.defineProperty(globalThis, "location", saved.location);
					} else {
						Reflect.deleteProperty(globalThis, "location");
					}
				}
			}) as unknown as GoodreadsCollectContext["page"]["evaluate"],
			goto: (async (url: string) => {
				visits.push(url);
				onVisit?.(url);
				return null;
			}) as unknown as GoodreadsCollectContext["page"]["goto"],
		},
		progress: async (message, extra) => {
			state.progress.push(message);
			state.messages.push({
				type: "PROGRESS",
				message,
				...extra,
			} as EmittedMessage);
		},
		reportStreamFailure: async (stream, message) => {
			state.failures.push({ message, stream });
		},
		requested: new Map(
			Object.entries(requested).map(([name, scope]) => [
				name,
				{ name, ...scope } as StreamScope,
			]),
		),
	};
	return state;
}

const ALL_STREAMS = {
	account_profile: {},
	books: {},
	shelves: {},
	usage_summary: {},
};

const skips = (h: Harness) =>
	h.messages.filter(
		(m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
			m.type === "SKIP_RESULT",
	);
const recordsOf = (h: Harness, stream: string) =>
	h.records.filter((r) => r.stream === stream).map((r) => r.data);

test("a full run reads every stream across two pages and proves the listing complete", async () => {
	const h = harness(signedInSite(), ALL_STREAMS);
	await collect(h.ctx);

	assert.deepEqual(h.failures, []);
	assert.deepEqual(skips(h), []);
	assert.equal(recordsOf(h, "books").length, 5);
	assert.equal(recordsOf(h, "shelves").length, 6);
	const profile = recordsOf(h, "account_profile");
	assert.equal(profile.length, 1);
	assert.deepEqual(profile[0]?.sources, { profile: "read", settings: "read" });
	assert.equal(profile[0]?.country, "NZ");
	assert.equal(profile[0]?.joined_on, "2019-03");
	const summary = recordsOf(h, "usage_summary");
	assert.equal(summary.length, 1);
	assert.equal(summary[0]?.books_total, 5);
	assert.deepEqual(summary[0]?.coverage, {
		books_listed: 5,
		books_with_finish_date: 3,
		list_pages: 2,
		listing_complete: true,
	});

	// One request at a time, in the documented order, at 100 a page.
	assert.deepEqual(
		h.paths.map((path) => path.split("&")[0]),
		[
			"/review/list",
			`/user/show/${UID}`,
			"/user/edit",
			`/review/list/${UID}?shelf=%23ALL%23`,
			`/review/list/${UID}?shelf=%23ALL%23`,
		],
	);
	assert.match(h.paths[3] ?? "", /per_page=100&page=1&print=true/);
	assert.match(h.paths[4] ?? "", /per_page=100&page=2&print=true/);
	assert.deepEqual(h.visits, []);
	assertUserFacingProgress(h.messages);
	assert.ok(h.progress.some((line) => /5 of 5 books/.test(line)));
});

test("what the account does not say about itself never reaches a record", async () => {
	const h = harness(signedInSite(), ALL_STREAMS);
	await collect(h.ctx);
	const accountRecords = JSON.stringify([
		...recordsOf(h, "account_profile"),
		...recordsOf(h, "usage_summary"),
		...recordsOf(h, "shelves"),
	]);
	for (const absent of [
		"Synthetic Reader",
		"synthetic-reader",
		"example.invalid",
		"Testland",
		"Prefers not to say",
	]) {
		assert.equal(accountRecords.includes(absent), false, absent);
	}
});

test("signed out: every requested stream stops with sign_in_required and nothing else is fetched", async () => {
	const h = harness(signedOutSite, ALL_STREAMS);
	await collect(h.ctx);

	assert.deepEqual(h.records, []);
	assert.equal(h.paths.length, 1);
	assert.deepEqual(
		skips(h)
			.map((skip) => [skip.stream, skip.reason])
			.sort(),
		[
			["account_profile", "sign_in_required"],
			["books", "sign_in_required"],
			["shelves", "sign_in_required"],
			["usage_summary", "sign_in_required"],
		],
	);
	assert.equal(h.failures.length, 4);
});

test("an empty library is a legitimate empty run: shelves and a zero summary, no failure", async () => {
	const h = harness(
		signedInSite({
			home: () => ({
				body: fixture("library-sidebar-empty.html"),
				url: `${ORIGIN}/review/list/${UID}-synthetic-reader`,
			}),
			print: () => ({ body: fixture("library-no-rows.html") }),
		}),
		{ books: {}, shelves: {}, usage_summary: {} },
	);
	await collect(h.ctx);

	assert.deepEqual(h.failures, []);
	assert.deepEqual(skips(h), []);
	assert.equal(recordsOf(h, "books").length, 0);
	assert.equal(recordsOf(h, "shelves").length, 3);
	const summary = recordsOf(h, "usage_summary")[0];
	assert.equal(summary?.books_total, 0);
	assert.equal(
		(summary?.coverage as { listing_complete: boolean } | undefined)
			?.listing_complete,
		true,
	);
});

test("a first page with no rows while the library has books is drift, not an empty library", async () => {
	const h = harness(
		signedInSite({ print: () => ({ body: fixture("library-no-rows.html") }) }),
		{ books: {}, usage_summary: {} },
	);
	await collect(h.ctx);

	assert.equal(recordsOf(h, "books").length, 0);
	assert.equal(recordsOf(h, "usage_summary").length, 0);
	const reasons = skips(h).map((skip) => [skip.stream, skip.reason]);
	assert.deepEqual(reasons.sort(), [
		["books", "source_unreadable"],
		["usage_summary", "listing_incomplete"],
	]);
	assert.equal(h.failures.length, 2);
	assert.match(
		skips(h).find((skip) => skip.stream === "books")?.message ?? "",
		/5 books but printed none/,
	);
});

test("a page this connector does not know stops the listing as unreadable", async () => {
	const h = harness(
		signedInSite({
			print: () => ({ body: "<html><body>Maintenance</body></html>" }),
		}),
		{ books: {} },
	);
	await collect(h.ctx);
	assert.deepEqual(
		skips(h).map((skip) => skip.reason),
		["source_unreadable"],
	);
});

test("an AWS WAF challenge loads the page once, then the retry succeeds", async () => {
	let cleared = false;
	const h = harness(
		signedInSite({
			print: (path, _call) => {
				if (path.includes("&page=1&") && !cleared) return WAF_CHALLENGE;
				return {
					body:
						PRINT_PAGES[new URL(path, ORIGIN).searchParams.get("page") ?? ""] ??
						fixture("library-no-rows.html"),
				};
			},
		}),
		{ books: {}, usage_summary: {} },
		() => {
			cleared = true;
		},
	);
	await collect(h.ctx);

	assert.deepEqual(h.failures, []);
	assert.equal(recordsOf(h, "books").length, 5);
	assert.equal(recordsOf(h, "usage_summary").length, 1);
	assert.equal(h.visits.length, 1);
	assert.match(h.visits[0] ?? "", /\/review\/list\/90000001\?.*&page=1&/);
	// The challenged page was asked for twice; the rest once.
	assert.equal(h.paths.filter((p) => p.includes("&page=1&")).length, 2);
});

test("an empty 200 is treated like a challenge, not like an empty library", async () => {
	let cleared = false;
	const h = harness(
		signedInSite({
			print: (path) =>
				path.includes("&page=1&") && !cleared
					? { body: "" }
					: {
							body:
								PRINT_PAGES[
									new URL(path, ORIGIN).searchParams.get("page") ?? ""
								] ?? fixture("library-no-rows.html"),
						},
		}),
		{ books: {} },
		() => {
			cleared = true;
		},
	);
	await collect(h.ctx);
	assert.equal(recordsOf(h, "books").length, 5);
	assert.deepEqual(h.failures, []);
});

test("a persistent WAF challenge fails with a clear reason and withholds the summary", async () => {
	const h = harness(signedInSite({ print: () => WAF_CHALLENGE }), {
		books: {},
		shelves: {},
		usage_summary: {},
	});
	await collect(h.ctx);

	assert.equal(recordsOf(h, "books").length, 0);
	assert.equal(recordsOf(h, "usage_summary").length, 0);
	// Shelves came from the sidebar before the challenge, and stay.
	assert.equal(recordsOf(h, "shelves").length, 6);
	const byStream = new Map(skips(h).map((skip) => [skip.stream, skip]));
	assert.equal(byStream.get("books")?.reason, "bot_challenge");
	assert.match(byStream.get("books")?.message ?? "", /verification check/);
	assert.equal(byStream.get("usage_summary")?.reason, "listing_incomplete");
	assert.equal(h.failures.length, 2);
	// One page load for the challenge, one retry, then stop: no loop.
	assert.equal(h.visits.length, 1);
	assert.equal(h.paths.filter((p) => p.includes("print=true")).length, 2);
});

test("a 503 is retried and then succeeds; the run does not fail", async () => {
	const h = harness(
		signedInSite({
			profile: (_path, call) =>
				call === 0
					? { body: "busy", status: 503 }
					: { body: fixture("profile.html") },
		}),
		{ account_profile: {} },
	);
	await collect(h.ctx);
	assert.deepEqual(h.failures, []);
	assert.deepEqual(recordsOf(h, "account_profile")[0]?.sources, {
		profile: "read",
		settings: "read",
	});
	assert.equal(h.paths.filter((p) => p.startsWith("/user/show")).length, 2);
});

test("a rate limit that does not lift stops the listing as interrupted, keeping the books read so far", async () => {
	const h = harness(
		signedInSite({
			print: (path) =>
				path.includes("&page=2&")
					? { body: "slow down", status: 429 }
					: { body: PRINT_PAGES["1"] ?? "" },
		}),
		{ books: {}, usage_summary: {} },
	);
	await collect(h.ctx);

	assert.equal(recordsOf(h, "books").length, 3);
	assert.equal(recordsOf(h, "usage_summary").length, 0);
	const byStream = new Map(skips(h).map((skip) => [skip.stream, skip.reason]));
	assert.equal(byStream.get("books"), "collection_interrupted");
	assert.equal(byStream.get("usage_summary"), "listing_incomplete");
	assert.equal(h.paths.filter((p) => p.includes("&page=2&")).length, 3);
});

test("a listing that ends short of the count is not complete and the summary is withheld", async () => {
	const h = harness(
		signedInSite({
			// The sidebar says 6, the list only ever has 5.
			home: () => ({
				body: fixture("library-sidebar.html").replace("All (5)", "All (6)"),
				url: `${ORIGIN}/review/list/${UID}-synthetic-reader`,
			}),
		}),
		{ books: {}, usage_summary: {} },
	);
	await collect(h.ctx);

	assert.equal(recordsOf(h, "books").length, 5);
	assert.equal(recordsOf(h, "usage_summary").length, 0);
	assert.match(
		skips(h).find((s) => s.stream === "books")?.message ?? "",
		/read 5 of 6/,
	);
	assert.equal(h.failures.length, 2);
});

test("a usage_summary-only request reads the whole listing but emits no books", async () => {
	const h = harness(signedInSite(), { usage_summary: {} });
	await collect(h.ctx);

	assert.deepEqual(h.failures, []);
	assert.equal(recordsOf(h, "books").length, 0);
	assert.equal(recordsOf(h, "usage_summary").length, 1);
	assert.equal(recordsOf(h, "usage_summary")[0]?.books_total, 5);
	// Only the home list and the print pages: no profile or settings request
	// when account_profile is not asked for.
	assert.deepEqual(
		h.paths.filter((p) => !p.includes("print=true")),
		["/review/list"],
	);
	assert.equal(h.paths.filter((p) => p.includes("print=true")).length, 2);
});

test("an account_profile-only request does not read the library", async () => {
	const h = harness(signedInSite(), { account_profile: {} });
	await collect(h.ctx);
	assert.equal(recordsOf(h, "account_profile").length, 1);
	assert.equal(
		h.paths.some((p) => p.includes("print=true")),
		false,
	);
});

test("a books-only request does not emit shelves, profile or summary", async () => {
	const h = harness(signedInSite(), { books: {} });
	await collect(h.ctx);
	assert.deepEqual([...new Set(h.records.map((r) => r.stream))], ["books"]);
});

test("consented fields: a dropped review and notes never reach the record", async () => {
	const h = harness(signedInSite(), {
		books: { fields: ["title", "rating", "added_on", "book_id"] },
	});
	await collect(h.ctx);
	const first = recordsOf(h, "books")[0];
	assert.deepEqual(Object.keys(first ?? {}).sort(), [
		"added_on",
		"book_id",
		"id",
		"rating",
		"title",
	]);
	assert.equal(
		JSON.stringify(h.records).includes("Lend to the book club"),
		false,
	);
	assert.equal(JSON.stringify(h.records).includes("salty novel"), false);
});

test("account_profile: a source Goodreads answered but this cannot read leaves a partial record", async () => {
	const h = harness(
		signedInSite({ settings: () => ({ body: "<html>redesigned</html>" }) }),
		{ account_profile: {} },
	);
	await collect(h.ctx);

	const record = recordsOf(h, "account_profile")[0];
	assert.deepEqual(record?.sources, { profile: "read", settings: "failed" });
	assert.equal(record?.joined_on, "2019-03");
	assert.equal(record?.country, null);
	assert.equal(record?.profile_visibility, null);
	assert.equal(record?.linked_sign_in, null);
	assert.equal(record?.favorite_genres, null);
	assert.deepEqual(h.failures, []);
});

test("account_profile: a source that did not answer this time stops the stream, emitting nothing", async () => {
	// A record with the settings half empty would replace a good stored one.
	for (const settings of [
		() => ({ body: "broken", status: 500 }),
		() => WAF_CHALLENGE,
		signedOutSite,
	]) {
		const h = harness(signedInSite({ settings }), { account_profile: {} });
		await collect(h.ctx);
		assert.equal(recordsOf(h, "account_profile").length, 0);
		assert.equal(h.failures.length, 1);
		assert.notEqual(skips(h)[0]?.reason, "source_unreadable");
	}
});

test("account_profile: both sources failing emits no record and stops the stream", async () => {
	const h = harness(
		signedInSite({
			profile: () => ({ body: "x", status: 404 }),
			settings: () => ({ body: "x", status: 404 }),
		}),
		{ account_profile: {} },
	);
	await collect(h.ctx);
	assert.equal(recordsOf(h, "account_profile").length, 0);
	assert.deepEqual(
		skips(h).map((skip) => skip.reason),
		["source_unreadable"],
	);
	assert.equal(h.failures.length, 1);
});

test("shelves are saved only when the sidebar is shown to be the whole list", async () => {
	const cases: [string, (html: string) => string, string][] = [
		[
			"a link to more shelves",
			(html) =>
				html.replace(
					'<div class="horizontalGreyDivider"></div>',
					'<div class="horizontalGreyDivider"></div><a href="#">more...</a>',
				),
			"shelf_list_incomplete",
		],
		[
			"exclusive counts short of All",
			(html) => html.replace("Abandoned  &lrm;(1)", "Abandoned  &lrm;(0)"),
			"shelf_list_incomplete",
		],
		[
			"a tag on a book that the sidebar lacks",
			(html) =>
				html.replace(
					/<div class="userShelf">\s*<a[^>]*tag=favorites-synthetic[^<]*<\/a>\s*<\/div>/,
					"",
				),
			"shelf_list_incomplete",
		],
		[
			"no shelves at all",
			(html) => html.replace(/<div class="userShelf">[\s\S]*?<\/div>/g, ""),
			"source_unreadable",
		],
	];
	for (const [label, edit, reason] of cases) {
		const h = harness(signedInSite({ home: () => sidebarHome(edit) }), {
			books: {},
			shelves: {},
		});
		await collect(h.ctx);
		assert.equal(recordsOf(h, "shelves").length, 0, label);
		assert.deepEqual(
			skips(h).map((skip) => [skip.stream, skip.reason]),
			[["shelves", reason]],
			label,
		);
		// The books are unaffected.
		assert.equal(recordsOf(h, "books").length, 5, label);
	}
});

test("a shelves-only run checks the sidebar without reading the library", async () => {
	const h = harness(signedInSite(), { shelves: {} });
	await collect(h.ctx);
	assert.equal(recordsOf(h, "shelves").length, 6);
	assert.deepEqual(h.paths, ["/review/list"]);
	assert.deepEqual(h.failures, []);
});

test("a host without the stream-failure hook fails the run instead of passing it", async () => {
	const h = harness(signedOutSite, { books: {} });
	const { reportStreamFailure: _hook, ...ctx } = h.ctx;
	await assert.rejects(collect(ctx), /goodreads_stream_failure_unreported/);
});

test("consented fields: the keys each stream's schema requires are always kept", async () => {
	const h = harness(signedInSite(), {
		account_profile: { fields: ["country"] },
		books: { fields: ["title"] },
		shelves: { fields: ["book_count"] },
		usage_summary: { fields: ["books_total"] },
	});
	await collect(h.ctx);
	assert.deepEqual(h.failures, []);
	assert.deepEqual(Object.keys(recordsOf(h, "books")[0] ?? {}).sort(), [
		"book_id",
		"id",
		"title",
	]);
	assert.deepEqual(Object.keys(recordsOf(h, "shelves")[0] ?? {}).sort(), [
		"book_count",
		"exclusive",
		"id",
		"name",
	]);
	assert.deepEqual(
		Object.keys(recordsOf(h, "account_profile")[0] ?? {}).sort(),
		["country", "id", "sources"],
	);
	assert.deepEqual(Object.keys(recordsOf(h, "usage_summary")[0] ?? {}).sort(), [
		"books_total",
		"coverage",
		"id",
	]);
});

test("a row this connector cannot read stops the listing as unreadable, not as a retry", async () => {
	const h = harness(
		signedInSite({
			print: (path) => {
				const page = new URL(path, ORIGIN).searchParams.get("page") ?? "";
				const body = PRINT_PAGES[page] ?? fixture("library-no-rows.html");
				return {
					body:
						page === "2"
							? body.replace('id="review_90100004"', 'id="row_4"')
							: body,
				};
			},
		}),
		{ books: {}, usage_summary: {} },
	);
	await collect(h.ctx);
	const byStream = new Map(skips(h).map((skip) => [skip.stream, skip]));
	assert.equal(byStream.get("books")?.reason, "source_unreadable");
	assert.match(byStream.get("books")?.message ?? "", /1 rows/);
	assert.equal(byStream.get("usage_summary")?.reason, "listing_incomplete");
	// The summary's message carries the cause.
	assert.match(byStream.get("usage_summary")?.message ?? "", /1 rows/);
});

test("a usage_summary-only run reports its progress under usage_summary", async () => {
	const h = harness(signedInSite(), { usage_summary: {} });
	await collect(h.ctx);
	const tagged = h.messages
		.filter((m) => m.type === "PROGRESS")
		.map((m) => (m as { stream?: string }).stream)
		.filter((stream) => stream !== undefined);
	assert.ok(tagged.length > 0);
	assert.deepEqual([...new Set(tagged)], ["usage_summary"]);
});

/**
 * The harness with the runtime's own record filter in front of it: the
 * generated consent table, scope.time_range and scope.resources, exactly as
 * the desktop and PageShim hosts apply them.
 */
function runtimeFiltered(h: Harness): Harness {
	const filtered = makeEmitRecord({
		emit: async (message) => {
			h.messages.push(message);
			if (message.type === "RECORD") {
				h.records.push({
					data: message.data as Record<string, unknown>,
					stream: message.stream,
				});
			}
		},
		emittedAt: "2026-11-03T00:00:00.000Z",
		isTombstone: undefined,
		requested: h.ctx.requested,
		timeRangeFieldFor: consentTimeFieldResolver("goodreads"),
		validateRecord,
	});
	h.ctx = { ...h.ctx, emitRecord: filtered.emit };
	return h;
}

test("a date range on books keeps the books added inside it, by calendar day", async () => {
	const addedOn = (h: Harness) =>
		recordsOf(h, "books")
			.map((book) => book.added_on as string)
			.sort();
	const all = runtimeFiltered(harness(signedInSite(), { books: {} }));
	await collect(all.ctx);
	const days = addedOn(all);
	assert.equal(days.length, 5);

	const since = runtimeFiltered(
		harness(signedInSite(), {
			books: { time_range: { since: "2026-01-01" } },
		}),
	);
	await collect(since.ctx);
	assert.deepEqual(
		addedOn(since),
		days.filter((day) => day >= "2026-01-01"),
	);
	assert.ok(addedOn(since).length > 0 && addedOn(since).length < 5);
	assert.deepEqual(since.failures, []);

	// until is exclusive: a book added on that day is outside.
	const until = runtimeFiltered(
		harness(signedInSite(), {
			books: { time_range: { until: days[2] as string } },
		}),
	);
	await collect(until.ctx);
	assert.deepEqual(
		addedOn(until),
		days.filter((day) => day < (days[2] as string)),
	);
});

test("a date range applies to books only; the other streams say they cannot take one", () => {
	const consent = consentTimeFieldResolver("goodreads");
	const range = { since: "2026-01-01" };
	assert.equal(
		timeRangeUnsupportedReason("books", range, consent("books")),
		null,
	);
	for (const stream of ["shelves", "account_profile", "usage_summary"]) {
		assert.match(
			timeRangeUnsupportedReason(stream, range, consent(stream)) ?? "",
			/no supported consent_time_field/,
			stream,
		);
	}
	// added_on is a calendar day, so an instant bound is the wrong type.
	assert.match(
		timeRangeUnsupportedReason(
			"books",
			{ since: "2026-01-01T00:00:00Z" },
			consent("books"),
		) ?? "",
		/must be a full-date/,
	);
});

test("a bounded run with a book that has no date added fails books with the count", async () => {
	const undated: Site = (path) => {
		const page = new URL(path, ORIGIN).searchParams.get("page") ?? "";
		const body = PRINT_PAGES[page] ?? fixture("library-no-rows.html");
		return {
			body:
				page === "1"
					? body.replace(
							/<td class="field date_added">[\s\S]*?<\/td>/,
							'<td class="field date_added"><label>date added</label><div class="value"></div></td>',
						)
					: body,
		};
	};
	const bounded = runtimeFiltered(
		harness(signedInSite({ print: undated }), {
			books: { time_range: { since: "2000-01-01" } },
			usage_summary: {},
		}),
	);
	await collect(bounded.ctx);
	assert.equal(recordsOf(bounded, "books").length, 4);
	assert.deepEqual(
		skips(bounded).map((skip) => [skip.stream, skip.reason]),
		[["books", "source_unreadable"]],
	);
	assert.match(skips(bounded)[0]?.message ?? "", /^1 books/);
	// The summary does not depend on the date added.
	assert.equal(recordsOf(bounded, "usage_summary").length, 1);

	// Without a range, an undated book is an ordinary record.
	const open = runtimeFiltered(
		harness(signedInSite({ print: undated }), { books: {} }),
	);
	await collect(open.ctx);
	assert.equal(recordsOf(open, "books").length, 5);
	assert.deepEqual(open.failures, []);
});

test("a resource selection keeps only the named books and shelves", async () => {
	const all = runtimeFiltered(harness(signedInSite(), { books: {} }));
	await collect(all.ctx);
	const wanted = recordsOf(all, "books")[1]?.id as string;
	const h = runtimeFiltered(
		harness(signedInSite(), {
			books: { resources: [wanted] },
			shelves: { resources: ["read"] },
		}),
	);
	await collect(h.ctx);
	assert.deepEqual(
		recordsOf(h, "books").map((book) => book.id),
		[wanted],
	);
	assert.deepEqual(
		recordsOf(h, "shelves").map((shelf) => shelf.id),
		["read"],
	);
	// The shelf check still sees the whole sidebar and library.
	assert.deepEqual(h.failures, []);
});

test("a run that asks for none of this connector's streams does nothing", async () => {
	const h = harness(signedInSite(), {});
	await collect(h.ctx);
	assert.deepEqual(h.paths, []);
	assert.deepEqual(h.messages, []);
});

test("every SKIP_RESULT reason the run can emit has display copy in the manifest", async () => {
	const reasons = new Set<string>();
	for (const site of [
		signedOutSite,
		signedInSite({ print: () => WAF_CHALLENGE }),
		signedInSite({ print: () => ({ body: fixture("library-no-rows.html") }) }),
		signedInSite({ print: () => ({ body: "x", status: 429 }) }),
		signedInSite({
			home: () => sidebarHome((html) => html.replace("All (5)", "All (6)")),
		}),
	]) {
		const h = harness(site, ALL_STREAMS);
		await collect(h.ctx);
		for (const skip of skips(h)) reasons.add(skip.reason);
	}
	assert.deepEqual([...reasons].sort(), [
		"bot_challenge",
		"collection_interrupted",
		"listing_incomplete",
		"shelf_list_incomplete",
		"sign_in_required",
		"source_unreadable",
	]);
	for (const reason of reasons) {
		assert.ok(manifest.reason_display_messages[reason], reason);
	}
});

// ─── Session probes ──────────────────────────────────────────────────────

interface FetchAnswer {
	body?: string;
	headers?: Record<string, string>;
	status?: number;
	url?: string;
}

/** What a signed-in library page has that a challenge page does not. */
const SIGNED_IN_BODY = '<a href="/user/sign_out">Sign out</a>';

/** Run the page probe's in-page function against a fake fetch. */
function probePage(answer: FetchAnswer | "network_error", origin = ORIGIN) {
	return {
		evaluate: (async (fn: (arg: unknown) => unknown, arg: unknown) => {
			const saved = globalThis.fetch;
			const savedLocation = Object.getOwnPropertyDescriptor(
				globalThis,
				"location",
			);
			Object.defineProperty(globalThis, "location", {
				configurable: true,
				value: { origin },
			});
			globalThis.fetch = (async () => {
				if (answer === "network_error") throw new TypeError("fetch failed");
				return {
					headers: new Headers(answer.headers ?? {}),
					status: answer.status ?? 200,
					text: async () => answer.body ?? SIGNED_IN_BODY,
					url: answer.url ?? `${ORIGIN}/review/list/${UID}-synthetic-reader`,
				};
			}) as unknown as typeof fetch;
			try {
				return await fn(arg);
			} finally {
				globalThis.fetch = saved;
				if (savedLocation)
					Object.defineProperty(globalThis, "location", savedLocation);
				else Reflect.deleteProperty(globalThis, "location");
			}
		}) as never,
	};
}

test("the page probe: signed in is true; every other answer is false", async () => {
	assert.equal(await probeGoodreadsPage(probePage({})), true);
	// A header link and sign-out link prove sign-in when the redirect URL is not shown.
	assert.equal(
		await probeGoodreadsPage(
			probePage({
				body: '<a href="/user/sign_out">x</a>',
				url: `${ORIGIN}/review/list`,
			}),
		),
		true,
	);
	assert.equal(
		await probeGoodreadsPage(
			probePage({ url: `${ORIGIN}/user/sign_in?returnurl=%2Freview%2Flist` }),
		),
		false,
	);
	assert.equal(
		await probeGoodreadsPage(probePage({ status: 202, body: "" })),
		false,
	);
	// A challenge can answer 200 at the owner's own list URL: the URL alone
	// is not proof.
	assert.equal(await probeGoodreadsPage(probePage({ body: "" })), false);
	assert.equal(
		await probeGoodreadsPage(
			probePage({ headers: { "x-amzn-waf-action": "challenge" } }),
		),
		false,
	);
	assert.equal(await probeGoodreadsPage(probePage("network_error")), false);
	assert.equal(
		await probeGoodreadsPage(probePage({}, "https://www.amazon.com")),
		false,
	);
});

function sessionPage(
	api: { status?: number; url?: string; location?: string } | "throws",
	inPage: FetchAnswer | "network_error" = "network_error",
) {
	const inner = probePage(inPage);
	const calls = { api: 0, dispose: 0 };
	return {
		calls,
		context: () => ({
			request: {
				get: async () => {
					calls.api += 1;
					if (api === "throws") throw new Error("socket hang up");
					return {
						dispose: async () => {
							calls.dispose += 1;
						},
						headers: () =>
							api.location === undefined ? {} : { location: api.location },
						status: () => api.status ?? 200,
						url: () =>
							api.url ?? `${ORIGIN}/review/list/${UID}-synthetic-reader`,
					};
				},
			},
		}),
		evaluate: inner.evaluate,
	};
}

test("the session probe trusts a clear answer over the cookie jar and never navigates", async () => {
	const signedIn = sessionPage({});
	assert.equal(await probeGoodreadsSession(signedIn as never), true);
	assert.equal(signedIn.calls.dispose, 1);

	const signedOut = sessionPage(
		{ url: `${ORIGIN}/user/sign_in?returnurl=x` },
		{},
	);
	// A clear sign-in redirect is final: the page's own answer is not consulted.
	assert.equal(await probeGoodreadsSession(signedOut as never), false);
});

test("the session probe reads the unfollowed redirect", async () => {
	// Live, the probe does not follow the redirect: Goodreads' 302 Location
	// is the answer, and it is the same request a recorded scenario holds.
	assert.equal(
		await probeGoodreadsSession(
			sessionPage(
				{
					location: `/review/list/${UID}-synthetic-reader`,
					status: 302,
					url: `${ORIGIN}/review/list`,
				},
				"network_error",
			) as never,
		),
		true,
	);
	assert.equal(
		await probeGoodreadsSession(
			sessionPage(
				{
					location: `${ORIGIN}/user/sign_in?returnurl=%2Freview%2Flist`,
					status: 302,
					url: `${ORIGIN}/review/list`,
				},
				{},
			) as never,
		),
		false,
	);
});

test("the session probe asks the page when the cookie-jar request is challenged", async () => {
	assert.equal(
		await probeGoodreadsSession(sessionPage({ status: 202 }, {}) as never),
		true,
	);
	assert.equal(
		await probeGoodreadsSession(sessionPage("throws", {}) as never),
		true,
	);
	assert.equal(
		await probeGoodreadsSession(
			sessionPage("throws", "network_error") as never,
		),
		false,
	);
});
