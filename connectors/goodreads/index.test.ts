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
import { type GoodreadsCollectContext, joinLibrary } from "./collector.ts";
import {
	FALLBACK_TOKEN_PAGE,
	GRAPHQL_URL,
	type GraphqlShelving,
} from "./graphql.ts";
import {
	CONNECTOR_CONFIG,
	collect,
	probeGoodreadsPage,
	probeGoodreadsSession,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { PrintBookRecord } from "./types.ts";

after(skipPoliteDelays());

const ORIGIN = "https://www.goodreads.com";
const UID = "90000001";
const fixture = (name: string): string =>
	readFileSync(new URL(`./fixtures/html/${name}`, import.meta.url), "utf8");
const apiFixture = (name: string): ApiBody =>
	JSON.parse(
		readFileSync(new URL(`./fixtures/api/${name}`, import.meta.url), "utf8"),
	) as ApiBody;
const NEXT_DATA = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(
	readFileSync(
		new URL("./fixtures/api/book-page.html", import.meta.url),
		"utf8",
	),
)?.[1] as string;
const FIRST_BOOK_PAGE = `${ORIGIN}/book/show/80000001-the-lighthouse-keepers-atlas`;
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

// ─── The fake book API ───────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: a GraphQL answer is free-form JSON.
type ApiBody = any;
/** A fake AppSync: `op` is the query's operation name, `call` counts earlier calls to it. */
type Api = (
	op: string,
	variables: { input: unknown; pagination: { after?: string; limit: number } },
	call: number,
) => SiteResponse;

/** The connection object inside a fixture answer, for editing in a test. */
const connectionOf = (body: ApiBody): ApiBody =>
	Object.values(body.data as Record<string, unknown>)[0];

/** The fixture API, with each answer passed through `edit[op]` first. */
function fixtureApi(
	edit: Partial<Record<string, (body: ApiBody) => ApiBody>> = {},
): Api {
	const files: Record<string, string> = {
		GoodreadsShelves: "shelves.json",
		GoodreadsShelvings: "shelvings.json",
		GoodreadsTags: "tags.json",
	};
	return (op) => {
		const file = files[op];
		if (!file) return { body: "{}", status: 400 };
		const body = apiFixture(file);
		return { body: JSON.stringify(edit[op]?.(body) ?? body) };
	};
}

/** The fixture shelvings with `edit` applied to each node. */
const editShelvings =
	(edit: (node: ApiBody, index: number) => ApiBody) => (body: ApiBody) => {
		const connection = connectionOf(body);
		connection.edges = connection.edges.map((edge: ApiBody, index: number) => ({
			node: edit(edge.node, index),
		}));
		return body;
	};

/** A JWT with the given claims, signed with nothing. */
function fakeToken(claims: Record<string, unknown>): string {
	const part = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${part({ alg: "none" })}.${part(claims)}.c2ln`;
}

/** The book page's __NEXT_DATA__ with its pageProps changed by `edit`. */
function nextData(edit: (pageProps: ApiBody) => void): string {
	const data = JSON.parse(NEXT_DATA);
	edit(data.props.pageProps);
	return JSON.stringify(data);
}

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

const signedOutSite: Site = () => ({
	body: fixture("signin.html"),
	url: `${ORIGIN}/user/sign_in?returnurl=%2Freview%2Flist`,
});

interface Harness {
	failures: { message: string; stream: string }[];
	/** The operation name of every API request, in order. */
	graphql: string[];
	messages: EmittedMessage[];
	paths: string[];
	progress: string[];
	records: { data: Record<string, unknown>; stream: string }[];
	visits: string[];
	ctx: GoodreadsCollectContext;
}

interface HarnessOptions {
	api?: Api;
	/** The __NEXT_DATA__ text of the page at `url`, or null for none. */
	bookPage?: (url: string, visit: number) => string | null;
	onVisit?: (url: string) => void;
}

function harness(
	site: Site,
	requested: Record<string, Partial<StreamScope>>,
	options: HarnessOptions | ((url: string) => void) = {},
): Harness {
	const {
		api = fixtureApi(),
		bookPage = () => NEXT_DATA,
		onVisit,
	} = typeof options === "function" ? { onVisit: options } : options;
	const paths: string[] = [];
	const graphql: string[] = [];
	const calls = new Map<string, number>();
	const visits: string[] = [];
	const state: Harness = {
		ctx: undefined as unknown as GoodreadsCollectContext,
		failures: [],
		graphql,
		messages: [],
		paths,
		progress: [],
		records: [],
		visits,
	};
	const fakeFetch = async (path: string, init?: RequestInit) => {
		let answer: SiteResponse;
		if (path === GRAPHQL_URL) {
			const request = JSON.parse(String(init?.body));
			const op = /^query (\w+)/.exec(request.query)?.[1] ?? "unnamed";
			const call = calls.get(op) ?? 0;
			calls.set(op, call + 1);
			graphql.push(op);
			answer = api(op, request.variables, call);
		} else {
			const call = calls.get(path) ?? 0;
			calls.set(path, call + 1);
			paths.push(path);
			answer = site(path, call);
		}
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
					document: Object.getOwnPropertyDescriptor(globalThis, "document"),
					fetch: globalThis.fetch,
					location: Object.getOwnPropertyDescriptor(globalThis, "location"),
				};
				const shown = visits.at(-1);
				const text =
					shown === undefined ? null : bookPage(shown, visits.length - 1);
				Object.defineProperty(globalThis, "location", {
					configurable: true,
					value: { origin: ORIGIN },
				});
				Object.defineProperty(globalThis, "document", {
					configurable: true,
					value: {
						getElementById: (id: string) =>
							id === "__NEXT_DATA__" && text !== null
								? { textContent: text }
								: null,
					},
				});
				globalThis.fetch = fakeFetch as unknown as typeof fetch;
				try {
					return await fn(arg);
				} finally {
					globalThis.fetch = saved.fetch;
					if (saved.document) {
						Object.defineProperty(globalThis, "document", saved.document);
					} else {
						Reflect.deleteProperty(globalThis, "document");
					}
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
/** Each DETAIL_COVERAGE the run emitted, as stream -> [considered, covered]. */
const coverageOf = (h: Harness) =>
	Object.fromEntries(
		h.messages
			.filter(
				(m): m is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
					m.type === "DETAIL_COVERAGE",
			)
			.map((m) => [m.stream, [m.considered, m.covered]]),
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
	// Then one book page for the API token, and the three API lists.
	assert.deepEqual(h.visits, [FIRST_BOOK_PAGE]);
	assert.deepEqual(h.graphql, [
		"GoodreadsShelvings",
		"GoodreadsShelves",
		"GoodreadsTags",
	]);
	assertUserFacingProgress(h.messages);
	assert.ok(h.progress.some((line) => /5 of 5 books/.test(line)));
});

test("a book joins the print list's fields with the API's, on book_id", async () => {
	const h = harness(signedInSite(), { books: {} });
	await collect(h.ctx);
	const book = recordsOf(h, "books").find((b) => b.book_id === "80000001");
	// From the print list.
	assert.equal(book?.added_on, "2021-03-05");
	assert.equal(book?.rating, 5);
	assert.equal(book?.exclusive_shelf, "read");
	// From the API.
	assert.equal(book?.added_at, "2021-03-05T18:00:00.000Z");
	assert.equal(book?.updated_at, "2022-01-20T12:30:00.000Z");
	assert.equal(book?.review_created_at, "2021-08-01T20:00:00.000Z");
	assert.equal(book?.review_has_spoilers, true);
	assert.equal(book?.publisher, "Harbour Light Books");
	assert.equal(book?.language, "English");
	assert.deepEqual(book?.genres, ["Fantasy", "Adventure", "Maps"]);
	assert.deepEqual(book?.series, [
		{ placement: "1", title: "The Atlas Cycle" },
	]);
	// A shelved book with no rating or review has no review instants.
	const unrated = recordsOf(h, "books").find((b) => b.book_id === "80000002");
	assert.equal(unrated?.review_created_at, null);
	assert.equal(unrated?.review_has_spoilers, null);
	const unnamed = recordsOf(h, "books").find((b) => b.book_id === "80000005");
	assert.equal(unnamed?.publisher, null);
	assert.deepEqual(unnamed?.series, [
		{ placement: "2.5", title: "Unfinished Maps" },
		{ placement: null, title: "Cartographers" },
	]);
});

test("shelves come from the API with display names and counts from the library", async () => {
	const h = harness(signedInSite(), { shelves: {} });
	await collect(h.ctx);
	assert.deepEqual(
		recordsOf(h, "shelves").map((s) => [
			s.id,
			s.name,
			s.exclusive,
			s.book_count,
		]),
		[
			["read", "Read", true, 2],
			["currently-reading", "Currently Reading", true, 1],
			["to-read", "Want to Read", true, 1],
			["abandoned", "Abandoned", true, 1],
			["favorites-synthetic", "favorites-synthetic", false, 1],
			["winter-list", "winter-list", false, 2],
		],
	);
	// A relative URL from the API is made absolute.
	assert.equal(
		recordsOf(h, "shelves").at(-1)?.url,
		`${ORIGIN}/review/list/${UID}?shelf=winter-list`,
	);
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
		{
			api: fixtureApi({
				GoodreadsShelves: (body) => {
					const connection = connectionOf(body);
					connection.edges = connection.edges.slice(0, 3);
					connection.totalCount = 3;
					return body;
				},
				GoodreadsShelvings: (body) => {
					const connection = connectionOf(body);
					connection.edges = [];
					connection.totalCount = 0;
					return body;
				},
				GoodreadsTags: (body) => {
					const connection = connectionOf(body);
					connection.edges = [];
					connection.totalCount = 0;
					return body;
				},
			}),
		},
	);
	await collect(h.ctx);

	assert.deepEqual(h.failures, []);
	assert.deepEqual(skips(h), []);
	assert.equal(recordsOf(h, "books").length, 0);
	assert.equal(recordsOf(h, "shelves").length, 3);
	// With no book to open, the token comes from a fixed book page.
	assert.deepEqual(h.visits, [FALLBACK_TOKEN_PAGE]);
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
	assert.equal(h.visits.length, 2);
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
	// Shelves come from the API, which the challenge did not stop.
	assert.equal(recordsOf(h, "shelves").length, 6);
	const byStream = new Map(skips(h).map((skip) => [skip.stream, skip]));
	assert.equal(byStream.get("books")?.reason, "bot_challenge");
	assert.match(byStream.get("books")?.message ?? "", /verification check/);
	assert.equal(byStream.get("usage_summary")?.reason, "listing_incomplete");
	assert.equal(h.failures.length, 2);
	// One page load for the challenge, one retry, then stop: no loop. The
	// second visit is the book page for the shelves' API token.
	assert.equal(h.visits.length, 2);
	assert.equal(h.visits[1], FALLBACK_TOKEN_PAGE);
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

test("a rate limit that does not lift stops the listing as interrupted and saves no books", async () => {
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

	// Books are saved only after the whole list is joined with the API.
	assert.equal(recordsOf(h, "books").length, 0);
	assert.deepEqual(h.graphql, []);
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

	assert.equal(recordsOf(h, "books").length, 0);
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
	assert.deepEqual(h.graphql, []);
	assert.deepEqual(h.visits, []);
});

test("an account_profile-only request does not read the library", async () => {
	const h = harness(signedInSite(), { account_profile: {} });
	await collect(h.ctx);
	assert.equal(recordsOf(h, "account_profile").length, 1);
	assert.equal(
		h.paths.some((p) => p.includes("print=true")),
		false,
	);
	assert.deepEqual(h.graphql, []);
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
	// added_at, the consent time field, stays so a time range can apply.
	assert.deepEqual(Object.keys(first ?? {}).sort(), [
		"added_at",
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

test("shelves are saved only when the API's lists are shown to be whole", async () => {
	const dropTag = (name: string) => (body: ApiBody) => {
		const connection = connectionOf(body);
		connection.edges = connection.edges.filter(
			(edge: ApiBody) => edge.node.name !== name,
		);
		connection.totalCount = connection.edges.length;
		return body;
	};
	const cases: [
		string,
		Partial<Record<string, (b: ApiBody) => ApiBody>>,
		string,
	][] = [
		[
			"fewer tags than the total",
			{
				GoodreadsTags: (body) => {
					connectionOf(body).totalCount = 3;
					return body;
				},
			},
			"shelf_list_incomplete",
		],
		[
			"a tag on a book that the list lacks",
			{ GoodreadsTags: dropTag("winter-list") },
			"shelf_list_incomplete",
		],
		[
			"a name on both lists",
			{
				GoodreadsTags: (body) => {
					const connection = connectionOf(body);
					connection.edges.push({ node: { name: "read", webUrl: null } });
					connection.totalCount = connection.edges.length;
					return body;
				},
			},
			"shelf_list_incomplete",
		],
		[
			"no shelves at all",
			{
				GoodreadsShelves: (body) => {
					const connection = connectionOf(body);
					connection.edges = [];
					connection.totalCount = 0;
					return body;
				},
			},
			"source_unreadable",
		],
	];
	for (const [label, edit, reason] of cases) {
		const h = harness(
			signedInSite(),
			{ books: {}, shelves: {} },
			{ api: fixtureApi(edit) },
		);
		await collect(h.ctx);
		assert.equal(recordsOf(h, "shelves").length, 0, label);
		assert.deepEqual(
			skips(h).map((skip) => [skip.stream, skip.reason]),
			[["shelves", reason]],
			label,
		);
		// The books are unaffected.
		assert.equal(recordsOf(h, "books").length, 5, label);
		assert.deepEqual(coverageOf(h), { books: [5, 5] }, label);
	}
});

test("a shelves-only run reads the API without the print list", async () => {
	const h = harness(signedInSite(), { shelves: {} });
	await collect(h.ctx);
	assert.equal(recordsOf(h, "shelves").length, 6);
	assert.deepEqual(h.paths, ["/review/list"]);
	assert.deepEqual(h.visits, [FALLBACK_TOKEN_PAGE]);
	assert.deepEqual(h.graphql, [
		"GoodreadsShelvings",
		"GoodreadsShelves",
		"GoodreadsTags",
	]);
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
		"added_at",
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

test("every count a run reports for books and shelves comes with its total", async () => {
	const h = harness(signedInSite(), { books: {}, shelves: {} });
	await collect(h.ctx);
	const counted = h.messages
		.filter((m) => m.type === "PROGRESS")
		.map((m) => m as { count?: number; stream?: string; total?: number })
		.filter((m) => m.count !== undefined);
	assert.deepEqual(
		counted.map((m) => [m.stream, m.count, m.total]),
		[
			// The print list's two pages, the API's one page, then the join.
			["books", 3, 5],
			["books", 5, 5],
			["books", 5, 5],
			["books", 5, 5],
			["shelves", 6, 6],
		],
	);
	assert.ok(h.progress.includes("Read details for 5 of 5 Goodreads books"));
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
function runtimeFiltered(
	h: Harness,
	isTombstone?: (stream: string, data: Record<string, unknown>) => boolean,
): Harness {
	const filtered = makeEmitRecord({
		emit: async (message) => {
			h.messages.push(message);
			// A deletion is a message, not a record.
			if (message.type === "RECORD" && message.op !== "delete") {
				h.records.push({
					data: message.data as Record<string, unknown>,
					stream: message.stream,
				});
			}
		},
		emittedAt: "2026-11-03T00:00:00.000Z",
		isTombstone,
		requested: h.ctx.requested,
		timeRangeFieldFor: consentTimeFieldResolver("goodreads"),
		validateRecord,
	});
	h.ctx = { ...h.ctx, emitRecord: filtered.emit };
	return h;
}

test("a date range on books keeps the books added inside it, by the instant added", async () => {
	const addedAt = (h: Harness) =>
		recordsOf(h, "books")
			.map((book) => book.added_at as string)
			.sort();
	const all = runtimeFiltered(harness(signedInSite(), { books: {} }));
	await collect(all.ctx);
	const instants = addedAt(all);
	assert.equal(instants.length, 5);

	const since = runtimeFiltered(
		harness(signedInSite(), {
			books: { time_range: { since: "2026-01-01T00:00:00Z" } },
		}),
	);
	await collect(since.ctx);
	assert.deepEqual(
		addedAt(since),
		instants.filter((at) => at >= "2026-01-01"),
	);
	assert.ok(addedAt(since).length > 0 && addedAt(since).length < 5);
	assert.deepEqual(since.failures, []);

	// until is exclusive: a book added at that instant is outside.
	const until = runtimeFiltered(
		harness(signedInSite(), {
			books: { time_range: { until: instants[2] as string } },
		}),
	);
	await collect(until.ctx);
	assert.deepEqual(
		addedAt(until),
		instants.filter((at) => at < (instants[2] as string)),
	);
});

test("a date range applies to books only; the other streams say they cannot take one", () => {
	const consent = consentTimeFieldResolver("goodreads");
	const range = { since: "2026-01-01T00:00:00Z" };
	assert.equal(
		timeRangeUnsupportedReason("books", range, consent("books")),
		null,
	);
	assert.deepEqual(consent("books"), {
		field: "added_at",
		format: "date-time",
	});
	for (const stream of ["shelves", "account_profile", "usage_summary"]) {
		assert.match(
			timeRangeUnsupportedReason(stream, range, consent(stream)) ?? "",
			/no supported consent_time_field/,
			stream,
		);
	}
});

test("an API entry without a date added stops books as unreadable", async () => {
	const h = harness(
		signedInSite(),
		{ books: {}, usage_summary: {} },
		{
			api: fixtureApi({
				GoodreadsShelvings: editShelvings((node, index) =>
					index === 0 ? { ...node, createdAt: null } : node,
				),
			}),
		},
	);
	await collect(h.ctx);
	assert.equal(recordsOf(h, "books").length, 0);
	assert.deepEqual(
		skips(h).map((skip) => [skip.stream, skip.reason]),
		[["books", "source_unreadable"]],
	);
	assert.match(skips(h)[0]?.message ?? "", /without the details/);
	// The summary does not depend on the API.
	assert.equal(recordsOf(h, "usage_summary").length, 1);
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
	// The shelf check still sees the whole library.
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
	const shortTags = fixtureApi({
		GoodreadsTags: (body) => {
			connectionOf(body).totalCount = 3;
			return body;
		},
	});
	for (const [site, api] of [
		[signedOutSite],
		[signedInSite({ print: () => WAF_CHALLENGE })],
		[
			signedInSite({
				print: () => ({ body: fixture("library-no-rows.html") }),
			}),
		],
		[signedInSite({ print: () => ({ body: "x", status: 429 }) })],
		[signedInSite(), shortTags],
	] as [Site, Api?][]) {
		const h = harness(site, ALL_STREAMS, api ? { api } : {});
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

// ─── The book API ───────────────────────────────────────────────────────

test("the print list and the API disagreeing on a book saves no books, and says why", async () => {
	const cases: [string, (node: ApiBody, index: number) => ApiBody, RegExp][] = [
		[
			"another shelf",
			(node, i) => (i === 0 ? { ...node, shelf: { name: "read" } } : node),
			/1 books have a different shelf, tags or rating/,
		],
		[
			"another rating",
			(node, i) =>
				i === 0 ? { ...node, review: { ...node.review, rating: 1 } } : node,
			/1 books have a different shelf, tags or rating/,
		],
		[
			"another tag",
			(node, i) => (i === 0 ? { ...node, taggings: [] } : node),
			/1 books have a different shelf, tags or rating/,
		],
		[
			"another book",
			(node, i) =>
				i === 0
					? { ...node, book: { ...node.book, legacyId: 80000099 } }
					: node,
			/1 books in the list are not in the API; 1 books in the API are not in the list/,
		],
	];
	for (const [label, edit, message] of cases) {
		const h = harness(
			signedInSite(),
			{ books: {}, shelves: {}, usage_summary: {} },
			{ api: fixtureApi({ GoodreadsShelvings: editShelvings(edit) }) },
		);
		await collect(h.ctx);
		assert.equal(recordsOf(h, "books").length, 0, label);
		const books = skips(h).find((skip) => skip.stream === "books");
		assert.equal(books?.reason, "collection_interrupted", label);
		assert.match(books?.message ?? "", message, label);
		// The summary needs only the print list.
		assert.equal(recordsOf(h, "usage_summary").length, 1, label);
		assert.equal(coverageOf(h).books, undefined, label);
		assert.deepEqual(coverageOf(h).usage_summary, [1, 1], label);
	}
});

test("an API listing shorter than its own total stops books and shelves as interrupted", async () => {
	const h = harness(
		signedInSite(),
		{ books: {}, shelves: {} },
		{
			api: fixtureApi({
				GoodreadsShelvings: (body) => {
					connectionOf(body).totalCount = 6;
					return body;
				},
			}),
		},
	);
	await collect(h.ctx);
	assert.deepEqual(h.records, []);
	assert.deepEqual(
		skips(h).map((skip) => [skip.stream, skip.reason]),
		[
			["books", "collection_interrupted"],
			["shelves", "collection_interrupted"],
		],
	);
	assert.match(skips(h)[0]?.message ?? "", /5 different books of the 6/);
	assert.deepEqual(coverageOf(h), {});
});

test("the API's pages are followed by their tokens; a repeated token stops the run", async () => {
	const twoPages: Api = (op, variables) => {
		if (op !== "GoodreadsShelvings") return fixtureApi()(op, variables, 0);
		const body = apiFixture("shelvings.json");
		const connection = connectionOf(body);
		const second = variables.pagination.after === "cGFnZTI=";
		connection.edges = second
			? connection.edges.slice(3)
			: connection.edges.slice(0, 3);
		connection.pageInfo = second
			? { hasNextPage: false, nextPageToken: null }
			: { hasNextPage: true, nextPageToken: "cGFnZTI=" };
		return { body: JSON.stringify(body) };
	};
	const h = harness(signedInSite(), { books: {} }, { api: twoPages });
	await collect(h.ctx);
	assert.deepEqual(h.failures, []);
	assert.equal(recordsOf(h, "books").length, 5);
	assert.deepEqual(h.graphql, ["GoodreadsShelvings", "GoodreadsShelvings"]);

	const looping: Api = (op, variables, call) => {
		const answer = JSON.parse(fixtureApi()(op, variables, call).body);
		connectionOf(answer).pageInfo = {
			hasNextPage: true,
			nextPageToken: "c2FtZQ==",
		};
		return { body: JSON.stringify(answer) };
	};
	const stuck = harness(signedInSite(), { books: {} }, { api: looping });
	await collect(stuck.ctx);
	assert.equal(stuck.graphql.length, 2);
	assert.equal(skips(stuck)[0]?.reason, "source_unreadable");
});

test("a refused token is read again once from a fresh page; refused twice stops the run", async () => {
	const refusedOnce: Api = (op, variables, call) =>
		op === "GoodreadsShelvings" && call === 0
			? {
					body: JSON.stringify({
						errors: [{ errorType: "UnauthorizedException", message: "x" }],
					}),
					status: 401,
				}
			: fixtureApi()(op, variables, call);
	const h = harness(signedInSite(), { books: {} }, { api: refusedOnce });
	await collect(h.ctx);
	assert.deepEqual(h.failures, []);
	assert.equal(recordsOf(h, "books").length, 5);
	assert.deepEqual(h.visits, [FIRST_BOOK_PAGE, FIRST_BOOK_PAGE]);

	const refused = harness(
		signedInSite(),
		{ books: {} },
		{ api: () => ({ body: "{}", status: 401 }) },
	);
	await collect(refused.ctx);
	assert.equal(refused.graphql.length, 2);
	assert.equal(skips(refused)[0]?.reason, "source_unreadable");
	assert.match(skips(refused)[0]?.message ?? "", /refused the token/);
});

test("a token close to its end is read again before the next request", async () => {
	const soon = nextData((props) => {
		props.jwtToken = fakeToken({
			exp: Math.floor(Date.now() / 1000) + 30,
			user_id: Number(UID),
		});
	});
	const h = harness(
		signedInSite(),
		{ books: {}, shelves: {} },
		{
			bookPage: () => soon,
		},
	);
	await collect(h.ctx);
	assert.deepEqual(h.failures, []);
	// One page load to open the API, then one before each of the 3 requests.
	assert.equal(h.visits.length, 4);
});

test("a book page without a usable token stops books and shelves with a reason", async () => {
	const cases: [string, (url: string) => string | null, string, RegExp][] = [
		["no __NEXT_DATA__", () => null, "source_unreadable", /sign-in token/],
		[
			"signed out",
			() =>
				nextData((props) => {
					props.authContextParams.signedIn = false;
					props.jwtToken = null;
				}),
			"sign_in_required",
			/signed out/,
		],
		[
			"another member's token",
			() =>
				nextData((props) => {
					props.jwtToken = fakeToken({ exp: 4102444800, user_id: 12345 });
				}),
			"source_unreadable",
			/different account/,
		],
	];
	for (const [label, bookPage, reason, message] of cases) {
		const h = harness(
			signedInSite(),
			{ books: {}, shelves: {}, usage_summary: {} },
			{ bookPage },
		);
		await collect(h.ctx);
		assert.deepEqual(
			skips(h).map((skip) => [skip.stream, skip.reason]),
			[
				["books", reason],
				["shelves", reason],
			],
			label,
		);
		assert.match(skips(h)[0]?.message ?? "", message, label);
		assert.equal(recordsOf(h, "usage_summary").length, 1, label);
	}
	// A missing token is looked for again after the WAF settle, then on a second load.
	const h = harness(signedInSite(), { shelves: {} }, { bookPage: () => null });
	await collect(h.ctx);
	assert.equal(h.visits.length, 2);
});

test("API errors: a 503 is retried; a GraphQL error or a strange answer stops the stream", async () => {
	const flaky: Api = (op, variables, call) =>
		op === "GoodreadsShelvings" && call < 2
			? { body: "busy", status: 503 }
			: fixtureApi()(op, variables, call);
	const h = harness(signedInSite(), { books: {} }, { api: flaky });
	await collect(h.ctx);
	assert.deepEqual(h.failures, []);
	assert.equal(h.graphql.length, 3);

	for (const [label, answer, reason] of [
		[
			"a validation error",
			{ body: JSON.stringify({ errors: [{ message: "Validation error" }] }) },
			"source_unreadable",
		],
		["not JSON", { body: "<html></html>" }, "source_unreadable"],
		[
			"no connection",
			{ body: JSON.stringify({ data: { getUserShelvings: null } }) },
			"source_unreadable",
		],
		["down", { body: "x", status: 500 }, "collection_interrupted"],
	] as [string, SiteResponse, string][]) {
		const failed = harness(
			signedInSite(),
			{ books: {} },
			{ api: () => answer },
		);
		await collect(failed.ctx);
		assert.equal(recordsOf(failed, "books").length, 0, label);
		assert.deepEqual(
			skips(failed).map((skip) => skip.reason),
			[reason],
			label,
		);
	}
});

// ─── Incremental runs ───────────────────────────────────────────────────

/** A run on the desktop runtime: collection mode set, deletions recognised. */
function desktop(
	h: Harness,
	collectionMode: "full_refresh" | "incremental",
	state: Record<string, unknown> = {},
): Harness {
	const filtered = runtimeFiltered(h, CONNECTOR_CONFIG.isTombstone);
	filtered.ctx = { ...filtered.ctx, collectionMode, state };
	return filtered;
}

const stateOf = (h: Harness): Record<string, unknown> =>
	Object.fromEntries(
		h.messages
			.filter((m) => m.type === "STATE")
			.map((m) => [
				(m as { stream: string }).stream,
				(m as { cursor: unknown }).cursor,
			]),
	);
const deletions = (h: Harness, stream: string) =>
	h.messages
		.filter(
			(m) =>
				m.type === "RECORD" &&
				(m as { op?: string }).op === "delete" &&
				(m as { stream: string }).stream === stream,
		)
		.map((m) => (m as { key: string }).key);

test("incremental: a second run emits only what changed, and deletions for what is gone", async () => {
	const first = desktop(
		harness(signedInSite(), { books: {}, shelves: {} }),
		"incremental",
	);
	await collect(first.ctx);
	assert.equal(recordsOf(first, "books").length, 5);
	assert.equal(recordsOf(first, "shelves").length, 6);
	const saved = stateOf(first);
	assert.deepEqual(Object.keys(saved).sort(), ["books", "shelves"]);

	const same = desktop(
		harness(signedInSite(), { books: {}, shelves: {} }),
		"incremental",
		saved,
	);
	await collect(same.ctx);
	assert.deepEqual(same.records, []);
	assert.deepEqual(same.failures, []);
	assert.deepEqual(stateOf(same), saved);

	// One book re-rated, as both sources show it.
	const rerated = (path: string, call: number) => {
		const answer = signedInSite()(path, call);
		return {
			...answer,
			body: answer.body.replace('data-rating="5.0"', 'data-rating="4.0"'),
		};
	};
	const changed = desktop(
		harness(
			signedInSite({
				print: (path, call) => {
					const page = new URL(path, ORIGIN).searchParams.get("page") ?? "";
					return page === "1"
						? rerated(path, call)
						: signedInSite()(path, call);
				},
			}),
			{ books: {}, shelves: {} },
			{
				api: fixtureApi({
					GoodreadsShelvings: editShelvings((node) => ({
						...node,
						review:
							node.book.legacyId === 80000001
								? { ...node.review, rating: 4 }
								: node.review,
					})),
				}),
			},
		),
		"incremental",
		saved,
	);
	await collect(changed.ctx);
	assert.deepEqual(changed.failures, []);
	assert.deepEqual(
		recordsOf(changed, "books").map((book) => [book.book_id, book.rating]),
		[["80000001", 4]],
	);
	// The shelves hold the same books as before.
	assert.deepEqual(recordsOf(changed, "shelves"), []);
	assert.deepEqual(deletions(changed, "books"), []);
	assert.deepEqual(deletions(changed, "shelves"), []);
});

test("incremental: a book its schema rejects is retried, not covered or saved", async () => {
	const tooLong = "x".repeat(2001);
	const rejecting = fixtureApi({
		GoodreadsShelvings: editShelvings((node) =>
			node.book.legacyId === 80000001
				? {
						...node,
						book: {
							...node.book,
							details: { ...node.book.details, publisher: tooLong },
						},
					}
				: node,
		),
	});
	const first = desktop(
		harness(signedInSite(), { books: {} }, { api: rejecting }),
		"incremental",
	);
	await collect(first.ctx);
	const kept = recordsOf(first, "books").map((book) => book.book_id);
	assert.equal(kept.length, 4);
	assert.ok(!kept.includes("80000001"));
	assert.ok(
		skips(first).some((skip) => skip.stream === "books"),
		"the runtime says why it skipped the book",
	);
	assert.deepEqual(coverageOf(first).books, [5, 4]);
	const saved = stateOf(first);
	const ids = (state: Record<string, unknown>) =>
		Object.keys(
			(state.books as { fingerprints: Record<string, string> }).fingerprints,
		).length;
	assert.equal(ids(saved), 4);

	// Fixed at the source: the next run sends the book it could not save.
	const fixed = desktop(
		harness(signedInSite(), { books: {} }),
		"incremental",
		saved,
	);
	await collect(fixed.ctx);
	assert.deepEqual(
		recordsOf(fixed, "books").map((book) => book.book_id),
		["80000001"],
	);
	assert.deepEqual(coverageOf(fixed).books, [5, 5]);
	const whole = stateOf(fixed);
	assert.equal(ids(whole), 5);

	// Broken again after it was saved: no deletion, and the saved fingerprint
	// stays so a later removal from Goodreads still deletes the saved copy.
	const broken = desktop(
		harness(signedInSite(), { books: {} }, { api: rejecting }),
		"incremental",
		whole,
	);
	await collect(broken.ctx);
	assert.deepEqual(deletions(broken, "books"), []);
	assert.deepEqual(coverageOf(broken).books, [5, 4]);
	assert.deepEqual(stateOf(broken), whole);
});

test("join: two list rows for one book cannot hide a book only the API lists", () => {
	const row = (book_id: string, id: string) =>
		({
			book_id,
			exclusive_shelf: "read",
			id,
			rating: null,
			shelves: ["read"],
		}) as unknown as PrintBookRecord;
	const shelving = (bookId: string): GraphqlShelving => ({
		addedAtMs: 0,
		bookId,
		genres: [],
		language: null,
		publisher: null,
		review: null,
		series: [],
		shelf: "read",
		tags: [],
		updatedAtMs: null,
	});
	const joined = joinLibrary(
		[row("A", "R1"), row("A", "R3")],
		[shelving("A"), shelving("B")],
	);
	assert.equal(joined.ok, false);
	assert.match(
		joined.ok ? "" : joined.message,
		/1 books in the API are not in the list; 1 books are in the list twice/,
	);
	assert.equal(joinLibrary([row("A", "R1")], [shelving("A")]).ok, true);
});

test("incremental: a book or shelf gone from Goodreads is emitted as a deletion", async () => {
	const streams = { books: {}, shelves: {} };
	const first = desktop(harness(signedInSite(), streams), "incremental");
	await collect(first.ctx);
	const saved = stateOf(first);
	const plus = (stream: string, id: string) => ({
		fingerprints: {
			...(saved[stream] as { fingerprints: Record<string, string> })
				.fingerprints,
			[id]: "0000",
		},
	});
	const next = desktop(harness(signedInSite(), streams), "incremental", {
		books: plus("books", "90199999"),
		shelves: plus("shelves", "old-shelf"),
	});
	await collect(next.ctx);
	assert.deepEqual(next.records, []);
	assert.deepEqual(deletions(next, "books"), ["90199999"]);
	assert.deepEqual(deletions(next, "shelves"), ["old-shelf"]);
	assert.deepEqual(stateOf(next), saved);
});

test("a full refresh emits every record, still marks deletions, and saves state", async () => {
	const first = desktop(harness(signedInSite(), { books: {} }), "incremental");
	await collect(first.ctx);
	const saved = stateOf(first);
	const refresh = desktop(
		harness(signedInSite(), { books: {} }),
		"full_refresh",
		{ books: { fingerprints: { "90199999": "0000" } } },
	);
	await collect(refresh.ctx);
	assert.equal(recordsOf(refresh, "books").length, 5);
	assert.deepEqual(deletions(refresh, "books"), ["90199999"]);
	assert.deepEqual(stateOf(refresh), saved);
});

test("a narrowed run, or a host without collection modes, emits every record and saves no state", async () => {
	const first = desktop(harness(signedInSite(), { books: {} }), "incremental");
	await collect(first.ctx);
	const saved = stateOf(first);
	for (const [label, scope] of [
		["time range", { time_range: { since: "2000-01-01T00:00:00Z" } }],
		["resources", { resources: ["90100001"] }],
	] as [string, Partial<StreamScope>][]) {
		const h = desktop(
			harness(signedInSite(), { books: scope }),
			"incremental",
			saved,
		);
		await collect(h.ctx);
		assert.ok(recordsOf(h, "books").length > 0, label);
		assert.deepEqual(stateOf(h), {}, label);
		assert.deepEqual(deletions(h, "books"), [], label);
	}
	// PageShim: no collectionMode, and its host stores each result whole.
	const shim = harness(signedInSite(), { books: {} });
	shim.ctx = { ...shim.ctx, state: saved };
	await collect(shim.ctx);
	assert.equal(recordsOf(shim, "books").length, 5);
	assert.deepEqual(stateOf(shim), {});
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

test("coverage: an un-narrowed run proves every stream it saved; a narrowed or failed one claims none", async () => {
	const whole = {
		account_profile: [1, 1],
		books: [5, 5],
		shelves: [6, 6],
		usage_summary: [1, 1],
	};
	const shim = harness(signedInSite(), ALL_STREAMS);
	await collect(shim.ctx);
	assert.deepEqual(coverageOf(shim), whole);

	// A quiet incremental run emits no records, yet still covers the stream.
	const first = desktop(harness(signedInSite(), ALL_STREAMS), "incremental");
	await collect(first.ctx);
	assert.deepEqual(coverageOf(first), whole);
	const quiet = desktop(
		harness(signedInSite(), ALL_STREAMS),
		"incremental",
		stateOf(first),
	);
	await collect(quiet.ctx);
	assert.deepEqual(recordsOf(quiet, "books"), []);
	assert.deepEqual(coverageOf(quiet), whole);

	// The runtime drops records outside the consent after the count is taken.
	const narrowed = desktop(
		harness(signedInSite(), {
			books: { time_range: { since: "2026-01-01T00:00:00Z" } },
			shelves: { resources: ["read"] },
		}),
		"incremental",
	);
	await collect(narrowed.ctx);
	assert.deepEqual(coverageOf(narrowed), {});

	const signedOut = harness(signedOutSite, ALL_STREAMS);
	await collect(signedOut.ctx);
	assert.deepEqual(coverageOf(signedOut), {});
});

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
