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
import { goodreadsPacingProfile } from "../../packages/polyfill-connectors/src/provider-profile.ts";
import { RUNTIME_GENERIC_REASON_CODES } from "../../packages/polyfill-connectors/src/reference-implementation-stand-in/runtime/recovery-reason-codes.ts";
import { skipPoliteDelays } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { timeRangeUnsupportedReason } from "../../packages/polyfill-connectors/src/time-range.ts";
import { type GoodreadsCollectContext, joinLibrary } from "./collector.ts";
import { type GoodreadsHttp, governed } from "./fetcher.ts";
import {
	FALLBACK_TOKEN_PAGE,
	GRAPHQL_URL,
	type GraphqlShelving,
} from "./graphql.ts";
import {
	CONNECTOR_CONFIG,
	collect,
	createGoodreadsHttp,
	GOODREADS_PACING_INITIAL_INTERVAL_MS,
	probeGoodreadsPage,
	probeGoodreadsSession,
	restoredPacingInterval,
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

const NOTES_PAGES: Record<string, string> = {
	"80000001": fixture("notes-book-1.html"),
	"80000099": fixture("notes-book-2.html"),
};

/** The book id of a notes page path, `/notes/<book>-<slug>/<owner>-<slug>`. */
const notesBookOf = (path: string): string | undefined =>
	/^\/notes\/(\d+)[^/]*\/\d+/.exec(new URL(path, ORIGIN).pathname)?.[1];

/**
 * The default signed-in site: sidebar, two print pages, profile, settings,
 * the Kindle notes list and one notes page per book in it.
 */
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
							: url.pathname === `/notes/${UID}/load_more`
								? "notesList"
								: notesBookOf(path)
									? "notes"
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
			case "notesList":
				return { body: JSON.stringify(apiFixture("notes-list.json")) };
			case "notes": {
				const page = NOTES_PAGES[notesBookOf(path) ?? ""];
				return page ? { body: page } : { body: "not found", status: 404 };
			}
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
	/** The fake clock the run's governor reads and advances. */
	clock: FakeClock;
	/** The governor of the last run, built from `ctx.state` at its start. */
	http?: GoodreadsHttp;
}

/** A clock that only moves when the governor waits; nothing really sleeps. */
interface FakeClock {
	nowMs: number;
	/** Each wait before a request, in order. */
	paces: number[];
	/** Each wait before a retry, in order. */
	retries: number[];
}

/** A fixed recent epoch, so a saved rate is fresh to the next fake run. */
const CLOCK_START_MS = Date.UTC(2026, 10, 1);

const newClock = (): FakeClock => ({
	nowMs: CLOCK_START_MS,
	paces: [],
	retries: [],
});

/**
 * Run the connector on the harness's fake clock with a governor built the
 * way the desktop runtime builds it: from the state the run starts with.
 */
function run(h: Harness): Promise<void> {
	const now = () => h.clock.nowMs;
	h.http = createGoodreadsHttp({
		now,
		random: () => 0.5,
		restoredIntervalMs: restoredPacingInterval(h.ctx.state, now),
		retrySleep: (ms) => {
			h.clock.retries.push(ms);
			h.clock.nowMs += ms;
		},
		sleep: (ms) => {
			h.clock.paces.push(ms);
			h.clock.nowMs += ms;
		},
	});
	return collect(h.ctx, h.http);
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
		clock: newClock(),
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
		reportStreamFailure: async (stream, message, options) => {
			// Every stop in every test: the SKIP_RESULT just before names who
			// acts next, and agrees with the failure on whether to retry.
			const skip = state.messages.at(-1) as {
				recovery_hint?: { action?: string; retryable?: boolean };
				stream?: string;
				type: string;
			};
			assert.equal(skip.type, "SKIP_RESULT");
			assert.equal(skip.stream, stream);
			assert.ok(
				RECOVERY_ACTIONS.has(skip.recovery_hint?.action ?? ""),
				`${stream} stop has a portable recovery action`,
			);
			assert.equal(skip.recovery_hint?.retryable, options?.retryable);
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
	highlights: {},
	shelves: {},
	usage_summary: {},
};

const skips = (h: Harness) =>
	h.messages.filter(
		(m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
			m.type === "SKIP_RESULT",
	);
/** The spec's portable recovery actions (collection profile, SKIP_RESULT). */
const RECOVERY_ACTIONS: ReadonlySet<string> = new Set([
	"manual_action_required",
	"not_retriable",
	"refresh_credentials",
	"retry_by_runtime",
	"retry_on_connector_upgrade",
	"unknown",
	"update_selector",
	"upstream_unblock",
]);
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
	await run(h);

	assert.deepEqual(h.failures, []);
	assert.deepEqual(skips(h), []);
	assert.equal(recordsOf(h, "books").length, 5);
	assert.equal(recordsOf(h, "shelves").length, 6);
	assert.equal(recordsOf(h, "highlights").length, 5);
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
			`/notes/${UID}/load_more`,
			`/notes/80000001-the-lighthouse-keepers-atlas/${UID}-synthetic-reader`,
			`/notes/80000099-tidewater-almanac/${UID}-synthetic-reader`,
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
	await run(h);
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
	await run(h);
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

test("expanding a shelf finds its books the way the server filters them", async () => {
	// The server expands a relationship as filter[<foreign_key>]=<parent id>,
	// and only a field of one scalar type is filterable (no arrays).
	const declared = JSON.parse(
		readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
	) as {
		streams: {
			name: string;
			relationships?: { foreign_key: string; stream: string }[];
			schema: { properties: Record<string, { type: string | string[] }> };
		}[];
	};
	const shelves = declared.streams.find((s) => s.name === "shelves");
	const books = declared.streams.find((s) => s.name === "books");
	assert.deepEqual(
		shelves?.relationships?.map((r) => [r.stream, r.foreign_key]),
		[["books", "exclusive_shelf"]],
	);
	const fkType = [books?.schema.properties.exclusive_shelf?.type]
		.flat()
		.filter((t) => t !== "null");
	assert.deepEqual(fkType, ["string"]);

	const h = harness(signedInSite(), { books: {}, shelves: {} });
	await run(h);
	const bookRecords = recordsOf(h, "books");
	for (const shelf of recordsOf(h, "shelves")) {
		const expanded = bookRecords.filter((b) => b.exclusive_shelf === shelf.id);
		const carrying = bookRecords.filter((b) =>
			(b.shelves as string[]).includes(shelf.id as string),
		);
		assert.equal(carrying.length, shelf.book_count, `${shelf.id} count`);
		// An exclusive shelf expands to every book on it; a tag expands to none.
		assert.equal(
			expanded.length,
			shelf.exclusive ? shelf.book_count : 0,
			`${shelf.id} expand`,
		);
	}
});

test("what the account does not say about itself never reaches a record", async () => {
	const h = harness(signedInSite(), ALL_STREAMS);
	await run(h);
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
	await run(h);

	assert.deepEqual(h.records, []);
	assert.equal(h.paths.length, 1);
	assert.deepEqual(
		skips(h)
			.map((skip) => [skip.stream, skip.reason])
			.sort(),
		[
			["account_profile", "sign_in_required"],
			["books", "sign_in_required"],
			["highlights", "sign_in_required"],
			["shelves", "sign_in_required"],
			["usage_summary", "sign_in_required"],
		],
	);
	assert.equal(h.failures.length, 5);
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
	await run(h);

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
	await run(h);

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
	await run(h);
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
	await run(h);

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
	await run(h);
	assert.equal(recordsOf(h, "books").length, 5);
	assert.deepEqual(h.failures, []);
});

test("a persistent WAF challenge fails with a clear reason and withholds the summary", async () => {
	const h = harness(signedInSite({ print: () => WAF_CHALLENGE }), {
		books: {},
		shelves: {},
		usage_summary: {},
	});
	await run(h);

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
	await run(h);
	assert.deepEqual(h.failures, []);
	assert.deepEqual(recordsOf(h, "account_profile")[0]?.sources, {
		profile: "read",
		settings: "read",
	});
	assert.equal(h.paths.filter((p) => p.startsWith("/user/show")).length, 2);
});

test("a rate limit that does not lift stops the listing as rate limited and saves no books", async () => {
	const h = harness(
		signedInSite({
			print: (path) =>
				path.includes("&page=2&")
					? { body: "slow down", status: 429 }
					: { body: PRINT_PAGES["1"] ?? "" },
		}),
		{ books: {}, usage_summary: {} },
	);
	await run(h);

	// Books are saved only after the whole list is joined with the API.
	assert.equal(recordsOf(h, "books").length, 0);
	assert.deepEqual(h.graphql, []);
	assert.equal(recordsOf(h, "usage_summary").length, 0);
	const byStream = new Map(skips(h).map((skip) => [skip.stream, skip.reason]));
	assert.equal(byStream.get("books"), "rate_limited");
	assert.equal(byStream.get("usage_summary"), "listing_incomplete");
	assert.equal(h.paths.filter((p) => p.includes("&page=2&")).length, 3);
});

test("a rate limit asking for an hour stops the listing at once", async () => {
	const h = harness(
		signedInSite({
			print: (path) =>
				path.includes("&page=2&")
					? {
							body: "slow down",
							headers: { "retry-after": "3600" },
							status: 429,
						}
					: { body: PRINT_PAGES["1"] ?? "" },
		}),
		{ books: {} },
	);
	await run(h);
	assert.equal(
		skips(h).find((s) => s.stream === "books")?.reason,
		"rate_limited",
	);
	assert.equal(h.paths.filter((p) => p.includes("&page=2&")).length, 1);
});

test("pacing: the governor waits before every request, starting no faster than the old pause", async () => {
	const h = harness(signedInSite(), ALL_STREAMS);
	// A second pacing layer would sleep on the real clock: catch any pause of
	// a second or more (the in-page fetch's 45 s abort timer is not one).
	const realPauses: number[] = [];
	const saved = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void, ms?: number) => {
		if (ms !== undefined && ms >= 1000 && ms < 45_000) realPauses.push(ms);
		return saved(fn, 0);
	}) as typeof setTimeout;
	try {
		await run(h);
	} finally {
		globalThis.setTimeout = saved;
	}
	assert.deepEqual(h.failures, []);
	assert.deepEqual(realPauses, []);

	// One wait per request (page fetches, page loads and API calls), all of
	// them the governor's: no second pacing layer adds its own.
	const requests = h.paths.length + h.graphql.length + h.visits.length;
	assert.equal(h.clock.paces.length, requests);
	assert.deepEqual(h.clock.retries, []);
	// A cold run starts at the old fixed pause's mean and only speeds up.
	assert.equal(h.clock.paces[0], GOODREADS_PACING_INITIAL_INTERVAL_MS);
	for (const [i, ms] of h.clock.paces.entries()) {
		assert.ok(ms <= (h.clock.paces[i - 1] ?? ms), `wait ${i} is no longer`);
	}
	// The run reports the rate it ended at, faster than it started.
	const rate = h.messages.find(
		(m) => m.type === "PROGRESS" && "collection_rate" in m,
	) as { collection_rate: { current_interval_ms: number } } | undefined;
	assert.ok(rate);
	assert.equal(
		rate.collection_rate.current_interval_ms,
		h.http?.governor.snapshot()?.intervalMs,
	);
	assert.ok(
		rate.collection_rate.current_interval_ms <
			GOODREADS_PACING_INITIAL_INTERVAL_MS,
	);
});

test("pacing: a 429 with Retry-After waits as asked, then slows the pace", async () => {
	let pacesAt429 = -1;
	const h: Harness = harness(
		signedInSite({
			print: (path, call) => {
				if (path.includes("&page=2&") && call === 0) {
					pacesAt429 = h.clock.paces.length;
					return {
						body: "slow down",
						headers: { "retry-after": "20" },
						status: 429,
					};
				}
				return {
					body:
						PRINT_PAGES[new URL(path, ORIGIN).searchParams.get("page") ?? ""] ??
						fixture("library-no-rows.html"),
				};
			},
		}),
		{ books: {} },
	);
	await run(h);

	assert.deepEqual(h.failures, []);
	assert.equal(recordsOf(h, "books").length, 5);
	// The retry waited the 20 s Goodreads asked for, not a backoff of its own.
	assert.deepEqual(h.clock.retries, [20_000]);
	// The wait before the 429 was the pace. The retry then waits on top of
	// the 20 s, and the request after it waits longer than before the 429.
	const before = h.clock.paces[pacesAt429 - 1] ?? 0;
	const after = h.clock.paces[pacesAt429 + 1] ?? 0;
	assert.ok(after > before, `pace slowed from ${before} ms to ${after} ms`);
	assert.equal(h.http?.governor.snapshot()?.lastBackoff?.reason, "throttle");
});

test("pacing: success speeds up to the profile's ceiling and never past it", async () => {
	let nowMs = CLOCK_START_MS;
	const paces: number[] = [];
	const http = createGoodreadsHttp({
		now: () => nowMs,
		sleep: (ms) => {
			paces.push(ms);
			nowMs += ms;
		},
	});
	for (let i = 0; i < 300; i += 1) {
		const answer = await governed(http, async () => ({
			retryAfter: null,
			status: 200,
		}));
		assert.equal(answer.ok, true);
	}
	const ceilingMs = goodreadsPacingProfile().pacingMinIntervalMs;
	assert.equal(paces[0], GOODREADS_PACING_INITIAL_INTERVAL_MS);
	assert.equal(Math.min(...paces), ceilingMs);
	assert.equal(paces.at(-1), ceilingMs);
	assert.equal(http.governor.snapshot()?.intervalMs, ceilingMs);
	for (const [i, ms] of paces.entries()) {
		assert.ok(ms <= (paces[i - 1] ?? ms), `wait ${i} is no longer`);
	}
});

test("pacing: an answer asking for too long a wait stops that request, not the next", async () => {
	const http = createGoodreadsHttp({ sleep: () => undefined });
	let sent = 0;
	// A 503 asking for an hour: no retry, the request fails at once.
	const refused = await governed(http, async () => {
		sent += 1;
		return { retryAfter: "3600", status: 503 };
	});
	assert.deepEqual(refused, { ok: false, rateLimited: false, status: 503 });
	assert.equal(sent, 1);
	// The next request's network failure is still retried.
	let attempts = 0;
	const next = await governed(http, async () => {
		attempts += 1;
		if (attempts === 1) throw new Error("connection reset");
		return { retryAfter: null, status: 200 };
	});
	assert.equal(next.ok, true);
	assert.equal(attempts, 2);
});

test("pacing: a WAF challenge is not a throttle; the reload and retry are paced", async () => {
	let cleared = false;
	const h = harness(
		signedInSite({
			print: (path) => {
				if (path.includes("&page=1&") && !cleared) return WAF_CHALLENGE;
				return {
					body:
						PRINT_PAGES[new URL(path, ORIGIN).searchParams.get("page") ?? ""] ??
						fixture("library-no-rows.html"),
				};
			},
		}),
		{ books: {} },
		() => {
			cleared = true;
		},
	);
	await run(h);

	assert.deepEqual(h.failures, []);
	assert.equal(recordsOf(h, "books").length, 5);
	assert.equal(h.http?.governor.snapshot()?.lastBackoff, null);
	assert.deepEqual(h.clock.retries, []);
	const requests = h.paths.length + h.graphql.length + h.visits.length;
	assert.equal(h.clock.paces.length, requests);
});

test("the book API's rate limit stops books as rate limited", async () => {
	const fixtures = fixtureApi();
	const h = harness(
		signedInSite(),
		{ books: {} },
		{
			api: (op, variables, call) =>
				op === "GoodreadsShelvings"
					? { body: "{}", status: 429 }
					: fixtures(op, variables, call),
		},
	);
	await run(h);
	assert.equal(recordsOf(h, "books").length, 0);
	assert.equal(
		skips(h).find((s) => s.stream === "books")?.reason,
		"rate_limited",
	);
	assert.equal(h.graphql.filter((op) => op === "GoodreadsShelvings").length, 3);
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
	await run(h);

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
	await run(h);

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
	await run(h);
	assert.equal(recordsOf(h, "account_profile").length, 1);
	assert.equal(
		h.paths.some((p) => p.includes("print=true")),
		false,
	);
	assert.deepEqual(h.graphql, []);
});

test("a books-only request does not emit shelves, profile or summary", async () => {
	const h = harness(signedInSite(), { books: {} });
	await run(h);
	assert.deepEqual([...new Set(h.records.map((r) => r.stream))], ["books"]);
});

test("consented fields: a dropped review and notes never reach the record", async () => {
	const h = harness(signedInSite(), {
		books: { fields: ["title", "rating", "added_on", "book_id"] },
	});
	await run(h);
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
	await run(h);

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
		await run(h);
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
	await run(h);
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
		await run(h);
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
	await run(h);
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
	await assert.rejects(
		collect(ctx, createGoodreadsHttp({ sleep: () => undefined })),
		/goodreads_stream_failure_unreported/,
	);
});

test("consented fields: the keys each stream's schema requires are always kept", async () => {
	const h = harness(signedInSite(), {
		account_profile: { fields: ["country"] },
		books: { fields: ["title"] },
		shelves: { fields: ["book_count"] },
		usage_summary: { fields: ["books_total"] },
	});
	await run(h);
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
	await run(h);
	const byStream = new Map(skips(h).map((skip) => [skip.stream, skip]));
	assert.equal(byStream.get("books")?.reason, "source_unreadable");
	assert.match(byStream.get("books")?.message ?? "", /1 rows/);
	assert.equal(byStream.get("usage_summary")?.reason, "listing_incomplete");
	// The summary's message carries the cause.
	assert.match(byStream.get("usage_summary")?.message ?? "", /1 rows/);
});

test("every count a run reports for books and shelves comes with its total", async () => {
	const h = harness(signedInSite(), { books: {}, shelves: {} });
	await run(h);
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
	await run(h);
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
	await run(all);
	const instants = addedAt(all);
	assert.equal(instants.length, 5);

	const since = runtimeFiltered(
		harness(signedInSite(), {
			books: { time_range: { since: "2026-01-01T00:00:00Z" } },
		}),
	);
	await run(since);
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
	await run(until);
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
	await run(h);
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
	await run(all);
	const wanted = recordsOf(all, "books")[1]?.id as string;
	const h = runtimeFiltered(
		harness(signedInSite(), {
			books: { resources: [wanted] },
			shelves: { resources: ["read"] },
		}),
	);
	await run(h);
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
	await run(h);
	assert.deepEqual(h.paths, []);
	assert.deepEqual(h.messages, []);
});

test("every SKIP_RESULT reason the run can emit has display copy, in the manifest or the runtime", async () => {
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
		[signedInSite({ print: () => ({ body: "x", status: 503 }) })],
		[signedInSite(), shortTags],
	] as [Site, Api?][]) {
		const h = harness(site, ALL_STREAMS, api ? { api } : {});
		await run(h);
		for (const skip of skips(h)) reasons.add(skip.reason);
	}
	assert.deepEqual([...reasons].sort(), [
		"bot_challenge",
		"collection_interrupted",
		"listing_incomplete",
		"rate_limited",
		"shelf_list_incomplete",
		"sign_in_required",
		"source_unreadable",
	]);
	for (const reason of reasons) {
		// The runtime owns copy for its generic codes; a manifest must not redeclare them.
		const generic = RUNTIME_GENERIC_REASON_CODES.has(reason);
		assert.equal(
			Boolean(manifest.reason_display_messages[reason]),
			!generic,
			reason,
		);
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
		await run(h);
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
	await run(h);
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
	await run(h);
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
	await run(stuck);
	assert.equal(stuck.graphql.length, 2);
	assert.equal(skips(stuck)[0]?.reason, "source_unreadable");
});

test("a library that changes between API pages is read again, not trusted", async () => {
	// Page 2 reports one more book than page 1: the owner shelved a book
	// mid-read, so the pages may have shifted. The counts still add up to the
	// first total, which is why the check has to be on the total itself.
	const shifting: Api = (op, variables) => {
		if (op !== "GoodreadsShelvings") return fixtureApi()(op, variables, 0);
		const body = apiFixture("shelvings.json");
		const connection = connectionOf(body);
		const second = variables.pagination.after === "cGFnZTI=";
		connection.edges = second
			? connection.edges.slice(3)
			: connection.edges.slice(0, 3);
		if (second) connection.totalCount += 1;
		connection.pageInfo = second
			? { hasNextPage: false, nextPageToken: null }
			: { hasNextPage: true, nextPageToken: "cGFnZTI=" };
		return { body: JSON.stringify(body) };
	};
	const h = harness(signedInSite(), { books: {} }, { api: shifting });
	await run(h);
	assert.equal(recordsOf(h, "books").length, 0);
	assert.deepEqual(coverageOf(h), {});
	assert.equal(skips(h)[0]?.reason, "collection_interrupted");
	assert.match(skips(h)[0]?.message ?? "", /5 became 6/);
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
	await run(h);
	assert.deepEqual(h.failures, []);
	assert.equal(recordsOf(h, "books").length, 5);
	assert.deepEqual(h.visits, [FIRST_BOOK_PAGE, FIRST_BOOK_PAGE]);

	const refused = harness(
		signedInSite(),
		{ books: {} },
		{ api: () => ({ body: "{}", status: 401 }) },
	);
	await run(refused);
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
	await run(h);
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
		await run(h);
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
	await run(h);
	assert.equal(h.visits.length, 2);
});

test("API errors: a 503 is retried; a GraphQL error or a strange answer stops the stream", async () => {
	const flaky: Api = (op, variables, call) =>
		op === "GoodreadsShelvings" && call < 2
			? { body: "busy", status: 503 }
			: fixtureApi()(op, variables, call);
	const h = harness(signedInSite(), { books: {} }, { api: flaky });
	await run(h);
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
		await run(failed);
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

/**
 * Each stream's saved cursor, without the governor's rate: the rate depends
 * on how the clock ran, and these tests are about records.
 */
const stateOf = (h: Harness): Record<string, unknown> =>
	Object.fromEntries(
		h.messages
			.filter((m) => m.type === "STATE")
			.map((m) => {
				const {
					pacing_interval_ms: _i,
					pacing_recorded_at_ms: _at,
					...rest
				} = (m as { cursor: Record<string, unknown> }).cursor;
				return [(m as { stream: string }).stream, rest];
			}),
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
	await run(first);
	assert.equal(recordsOf(first, "books").length, 5);
	assert.equal(recordsOf(first, "shelves").length, 6);
	const saved = stateOf(first);
	assert.deepEqual(Object.keys(saved).sort(), ["books", "shelves"]);

	const same = desktop(
		harness(signedInSite(), { books: {}, shelves: {} }),
		"incremental",
		saved,
	);
	await run(same);
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
	await run(changed);
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
	await run(first);
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
	await run(fixed);
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
	await run(broken);
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
	await run(first);
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
	await run(next);
	assert.deepEqual(next.records, []);
	assert.deepEqual(deletions(next, "books"), ["90199999"]);
	assert.deepEqual(deletions(next, "shelves"), ["old-shelf"]);
	assert.deepEqual(stateOf(next), saved);
});

test("a full refresh emits every record, still marks deletions, and saves state", async () => {
	const first = desktop(harness(signedInSite(), { books: {} }), "incremental");
	await run(first);
	const saved = stateOf(first);
	const refresh = desktop(
		harness(signedInSite(), { books: {} }),
		"full_refresh",
		{ books: { fingerprints: { "90199999": "0000" } } },
	);
	await run(refresh);
	assert.equal(recordsOf(refresh, "books").length, 5);
	assert.deepEqual(deletions(refresh, "books"), ["90199999"]);
	assert.deepEqual(stateOf(refresh), saved);
});

test("a narrowed run, or a host without collection modes, emits every record and saves no state", async () => {
	const first = desktop(harness(signedInSite(), { books: {} }), "incremental");
	await run(first);
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
		await run(h);
		assert.ok(recordsOf(h, "books").length > 0, label);
		assert.deepEqual(stateOf(h), {}, label);
		assert.deepEqual(deletions(h, "books"), [], label);
	}
	// PageShim: no collectionMode, and its host stores each result whole.
	const shim = harness(signedInSite(), { books: {} });
	shim.ctx = { ...shim.ctx, state: saved };
	await run(shim);
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
		highlights: [5, 5],
		shelves: [6, 6],
		usage_summary: [1, 1],
	};
	const shim = harness(signedInSite(), ALL_STREAMS);
	await run(shim);
	assert.deepEqual(coverageOf(shim), whole);

	// A quiet incremental run emits no records, yet still covers the stream.
	const first = desktop(harness(signedInSite(), ALL_STREAMS), "incremental");
	await run(first);
	assert.deepEqual(coverageOf(first), whole);
	const quiet = desktop(
		harness(signedInSite(), ALL_STREAMS),
		"incremental",
		stateOf(first),
	);
	await run(quiet);
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
	await run(narrowed);
	assert.deepEqual(coverageOf(narrowed), {});

	const signedOut = harness(signedOutSite, ALL_STREAMS);
	await run(signedOut);
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

// ─── Kindle highlights and notes ────────────────────────────────────────

/** The fixture notes list with `edit` applied to its parsed body. */
const notesList =
	(edit: (body: ApiBody, token: string | null) => ApiBody): Site =>
	(path) => ({
		body: JSON.stringify(
			edit(
				apiFixture("notes-list.json"),
				new URL(path, ORIGIN).searchParams.get("start_token"),
			),
		),
	});

test("highlights: every item of every annotated book, keyed so a later note keeps the id", async () => {
	const h = harness(signedInSite(), { highlights: {} });
	await run(h);

	assert.deepEqual(h.failures, []);
	// A highlights-only run reads the notes, not the library.
	assert.deepEqual(h.paths, [
		"/review/list",
		`/notes/${UID}/load_more`,
		`/notes/80000001-the-lighthouse-keepers-atlas/${UID}-synthetic-reader`,
		`/notes/80000099-tidewater-almanac/${UID}-synthetic-reader`,
	]);
	const records = recordsOf(h, "highlights");
	assert.deepEqual(
		records.map((r) => [r.id, r.position, r.location_percent]),
		[
			["80000001:QVNZTlRISEwwMDAx", 1, 4],
			["80000001:QVNZTlRISEwwMDAy", 2, 37],
			// A note with no highlight is keyed by the note.
			["80000001:QVNZTlRITk8wMDAz", 3, 52],
			// A location that is not a percentage is kept as text only.
			["80000099:QVNZTlRISEwwMDk5", 1, null],
			// A highlight Goodreads shows as an empty card is kept, without text.
			["80000099:QVNZTlRISEwwMDk4", 2, null],
		],
	);
	assert.deepEqual(records[1], {
		asin: "B0SYNTH0001",
		author: "Mara Quill",
		book_id: "80000001",
		book_title: "The Lighthouse Keeper's Atlas",
		highlight_id: "QVNZTlRISEwwMDAy",
		highlight_text: "The keeper lit the lamp for a ship that had already sunk.",
		id: "80000001:QVNZTlRISEwwMDAy",
		location: "37%",
		location_percent: 37,
		note_id: "QVNZTlRITk8wMDAy",
		note_text: "The ending, foreshadowed.\nCheck chapter 9 again.",
		notes_url: `${ORIGIN}/notes/80000001-the-lighthouse-keepers-atlas/${UID}-synthetic-reader`,
		position: 2,
		shared: true,
		spoiler: true,
	});
	assert.equal(
		records[0]?.highlight_text,
		"Every coast keeps a second map,\ndrawn by the people who were wrecked on it.",
	);
	assert.equal(records[2]?.highlight_text, null);
	assert.deepEqual(
		[records[4]?.highlight_id, records[4]?.highlight_text, records[4]?.note_id],
		["QVNZTlRISEwwMDk4", null, null],
	);
	assert.deepEqual(coverageOf(h), { highlights: [5, 5] });
	assert.ok(h.progress.some((line) => /2 of 2 books/.test(line)));
	assertUserFacingProgress(h.messages);
});

test("highlights: the notes list is followed page by page with its start token", async () => {
	const site = signedInSite({
		notesList: notesList((body, token) => {
			const [first, second] = body.annotated_books_collection;
			return token === null
				? { annotated_books_collection: [first], next_token: "token two" }
				: { annotated_books_collection: [second], next_token: null };
		}),
	});
	const h = harness(site, { highlights: {} });
	await run(h);

	assert.deepEqual(h.failures, []);
	assert.deepEqual(h.paths.slice(1, 3), [
		`/notes/${UID}/load_more`,
		`/notes/${UID}/load_more?start_token=token%20two`,
	]);
	assert.equal(recordsOf(h, "highlights").length, 5);
});

test("highlights: a notes list that does not finish or repeats itself saves nothing", async () => {
	const cases: [string, Site, string][] = [
		["an unknown answer", notesList(() => ({})), "source_unreadable"],
		[
			"a book without a notes link",
			notesList((body) => {
				body.annotated_books_collection[0].readingNotesUrl = "/book/show/1";
				return body;
			}),
			"source_unreadable",
		],
		[
			"a token that does not move",
			notesList((body) => ({ ...body, next_token: "same" })),
			// The second page repeats the first page's books.
			"collection_interrupted",
		],
		[
			"an empty page that claims more",
			notesList(() => ({ annotated_books_collection: [], next_token: "more" })),
			"source_unreadable",
		],
	];
	for (const [label, notesListSite, reason] of cases) {
		const h = harness(signedInSite({ notesList: notesListSite }), {
			books: {},
			highlights: {},
		});
		await run(h);
		assert.deepEqual(recordsOf(h, "highlights"), [], label);
		assert.deepEqual(
			skips(h).map((skip) => [skip.stream, skip.reason]),
			[["highlights", reason]],
			label,
		);
		// The other streams are not held back by it.
		assert.equal(recordsOf(h, "books").length, 5, label);
	}
});

test("highlights: a notes page that shows fewer items than it counts, or another book, saves nothing", async () => {
	const book1 = fixture("notes-book-1.html");
	const cases: [string, string][] = [
		[
			"a short page",
			book1.replace('data-total-count="3"', 'data-total-count="4"'),
		],
		[
			"another book's page",
			fixture("notes-book-2.html").replaceAll("80000099", "80000555"),
		],
		[
			"an item it cannot read",
			book1.replace(
				'data-has-note="true" data-is-spoiler="true"',
				'data-has-note="false" data-is-spoiler="true"',
			),
		],
		["a redesigned page", "<html><body>redesigned</body></html>"],
		[
			"an item without the usual card",
			book1.replace(
				'<div class="noteHighlightTextContainer">',
				'<div class="annotationCard">',
			),
		],
	];
	for (const [label, page] of cases) {
		const h = harness(
			signedInSite({
				notes: (path, call) =>
					notesBookOf(path) === "80000001"
						? { body: page }
						: signedInSite()(path, call),
			}),
			{ highlights: {} },
		);
		await run(h);
		assert.deepEqual(h.records, [], label);
		assert.deepEqual(
			skips(h).map((skip) => [skip.stream, skip.reason]),
			[["highlights", "source_unreadable"]],
			label,
		);
		// No book title reaches the message: books are named by their place.
		assert.match(h.failures[0]?.message ?? "", /book 1 of 2/, label);
		assert.doesNotMatch(h.failures[0]?.message ?? "", /Lighthouse/, label);
	}
});

test("highlights incremental: a note added keeps the record's id; a book gone is deleted", async () => {
	const first = desktop(
		harness(signedInSite(), { highlights: {} }),
		"incremental",
	);
	await run(first);
	assert.equal(recordsOf(first, "highlights").length, 5);
	const saved = stateOf(first);

	const noted = fixture("notes-book-1.html")
		.replace(
			'QVNZTlRISEwwMDAx%7C-0-%7C" data-book-id="80000001" data-has-note="false"',
			'QVNZTlRISEwwMDAx%7C-0-%7CQVNZTlRITk8wMDAx" data-book-id="80000001" data-has-note="true"',
		)
		.replace(
			'contenteditable="" tabindex="0"></div>',
			'contenteditable="" tabindex="0">Later thought.</div>',
		);
	assert.notEqual(noted, fixture("notes-book-1.html"));
	const second = desktop(
		harness(
			signedInSite({
				notes: (path, call) =>
					notesBookOf(path) === "80000001"
						? { body: noted }
						: signedInSite()(path, call),
				notesList: notesList((body) => ({
					...body,
					annotated_books_collection: body.annotated_books_collection.slice(
						0,
						1,
					),
				})),
			}),
			{ highlights: {} },
		),
		"incremental",
		saved,
	);
	await run(second);
	assert.deepEqual(second.failures, []);
	assert.deepEqual(
		recordsOf(second, "highlights").map((r) => [r.id, r.note_id, r.note_text]),
		[["80000001:QVNZTlRISEwwMDAx", "QVNZTlRITk8wMDAx", "Later thought."]],
	);
	assert.deepEqual(deletions(second, "highlights"), [
		"80000099:QVNZTlRISEwwMDk5",
		"80000099:QVNZTlRISEwwMDk4",
	]);
});

test("highlights: when no highlight has text, Goodreads moved it and nothing is saved", async () => {
	const textless = (name: string) =>
		fixture(name).replace(
			/<div class="noteHighlightTextContainer__highlightContainer">[\s\S]*?<\/span>\s*<\/div>\s*<\/div>/g,
			"",
		);
	assert.doesNotMatch(textless("notes-book-1.html"), /highlightText/);
	const h = harness(
		signedInSite({
			notes: (path) => ({
				body: textless(
					notesBookOf(path) === "80000001"
						? "notes-book-1.html"
						: "notes-book-2.html",
				),
			}),
		}),
		{ highlights: {} },
	);
	await run(h);
	assert.deepEqual(h.records, []);
	assert.deepEqual(
		skips(h).map((skip) => [skip.stream, skip.reason]),
		[["highlights", "source_unreadable"]],
	);
});

/** Each stream's saved cursor as emitted, the governor's rate included. */
const rawStateOf = (h: Harness): Record<string, unknown> =>
	Object.fromEntries(
		h.messages
			.filter((m) => m.type === "STATE")
			.map((m) => [
				(m as { stream: string }).stream,
				(m as { cursor: unknown }).cursor,
			]),
	);

test("pacing: the next run starts from the rate this run learned, unless it is stale", async () => {
	const first = desktop(
		harness(signedInSite(), { books: {}, highlights: {}, shelves: {} }),
		"incremental",
	);
	await run(first);
	const saved = rawStateOf(first);
	const learned = first.http?.governor.snapshot()?.intervalMs;
	assert.ok(
		learned !== undefined && learned < GOODREADS_PACING_INITIAL_INTERVAL_MS,
	);
	// Every stream saves the rate; the newest save is the run's last one.
	for (const stream of ["books", "highlights", "shelves"]) {
		const cursor = saved[stream] as Record<string, unknown>;
		assert.equal(typeof cursor.pacing_interval_ms, "number", stream);
	}
	assert.equal(
		(saved.highlights as Record<string, unknown>).pacing_interval_ms,
		learned,
	);

	const warm = desktop(
		harness(signedInSite(), { books: {}, highlights: {}, shelves: {} }),
		"incremental",
		saved,
	);
	warm.clock.nowMs = first.clock.nowMs + 60_000;
	await run(warm);
	assert.equal(warm.clock.paces[0], learned);

	const stale = desktop(
		harness(signedInSite(), { books: {}, highlights: {}, shelves: {} }),
		"incremental",
		saved,
	);
	stale.clock.nowMs = first.clock.nowMs + 7 * 60 * 60 * 1000;
	await run(stale);
	assert.equal(stale.clock.paces[0], GOODREADS_PACING_INITIAL_INTERVAL_MS);
});
