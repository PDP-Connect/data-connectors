// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The PageShim posts path: the capture rules, the request-variables reader
// and the cursor walk over what the shared in-page capture
// (page-exchange-capture.ts) buffers. The walk runs on a fake page whose
// documents are node:vm realms with the real capture script installed; the
// "app" sends its posts requests through the realm's wrapped XMLHttpRequest.
// scripts/pageshim/pageshim.test.mjs runs the same path against a synthetic
// Instagram app in Chromium.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import {
	createPageExchangeCapture,
} from "../../packages/polyfill-connectors/src/page-exchange-capture.ts";
import {
	createFakePage,
	type FakeDocument,
	plain,
} from "../../packages/polyfill-connectors/src/test-fixtures/page-exchange-realm.ts";
import { fetchAllPostsMobile } from "./index.ts";
import {
	isOwnerProfilePath,
	openProfileScript,
	POSTS_CAPTURE_MAX_BUFFERED,
	POSTS_CAPTURE_NAME,
	POSTS_CAPTURE_RULES,
	POSTS_SCROLL_SCRIPT,
	postsRequestVariablesText,
} from "./mobile.ts";

const NO_DELAY = (): Promise<void> => Promise.resolve();
const FAST_CLOCK = { sleep: async (): Promise<void> => undefined };
const OWNER = { id: "u1", username: "testuser" };
const ORIGIN = "https://www.instagram.com";

function postsForm(variables: Record<string, unknown>, operation = "PolarisProfilePostsQuery"): string {
	return new URLSearchParams({
		fb_dtsg: "SECRET-DTSG",
		lsd: "SECRET-LSD",
		jazoest: "2",
		fb_api_req_friendly_name: operation,
		variables: JSON.stringify(variables),
		doc_id: "123",
	}).toString();
}

test("capture rules: a POST to the GraphQL path whose body names a posts operation", async () => {
	const page = createFakePage({ url: `${ORIGIN}/`, onFetch: async () => new Response('{"page":2}', { status: 200 }) });
	const capture = await createPageExchangeCapture(page, {
		name: POSTS_CAPTURE_NAME, rules: POSTS_CAPTURE_RULES, maxBuffered: POSTS_CAPTURE_MAX_BUFFERED,
	});
	await capture.attach();
	const doc = page.document;
	doc.xhr("POST", "/graphql/query", postsForm({ username: "testuser" })).finish(200, '{"data":{}}');
	// Not a posts operation, not a POST, not the GraphQL path, not this origin.
	doc.xhr("POST", "/api/graphql", postsForm({}, "PolarisFeedTimelineRootQuery")).finish(200, "{}");
	doc.xhr("GET", "/graphql/query?PolarisProfilePostsQuery", null).finish(200, "{}");
	doc.xhr("POST", "/api/v1/feed/", postsForm({})).finish(200, "{}");
	doc.xhr("POST", "https://other.example/graphql", postsForm({})).finish(200, "{}");
	doc.xhr("POST", "/api/graphql", postsForm({ after: "c1" })).finish(500, "nope");
	await doc.fetch("/api/graphql", {
		method: "POST",
		body: JSON.stringify({ fb_api_req_friendly_name: "UserMediaQuery", variables: { username: "b" } }),
	});
	await page.settle();
	const { exchanges } = await capture.drain();
	assert.deepEqual(plain(exchanges).map((exchange) => ({
		variables: postsRequestVariablesText(exchange.requestBody), status: exchange.status, body: exchange.responseText,
	})), [
		{ variables: '{"username":"testuser"}', status: 200, body: '{"data":{}}' },
		{ variables: '{"after":"c1"}', status: 500, body: "nope" },
		{ variables: '{"username":"b"}', status: 200, body: '{"page":2}' },
	]);
});

test("request variables: form or JSON, never an over-long value", () => {
	assert.equal(postsRequestVariablesText(postsForm({ a: 1 })), '{"a":1}');
	assert.equal(postsRequestVariablesText(JSON.stringify({ variables: { a: 1 } })), '{"a":1}');
	assert.equal(postsRequestVariablesText(JSON.stringify({ variables: '{"a":1}' })), '{"a":1}');
	assert.equal(postsRequestVariablesText(null), "");
	assert.equal(postsRequestVariablesText("doc_id=1"), "");
	assert.equal(postsRequestVariablesText(postsForm({ long: "x".repeat(9000) })), "");
});

test("profile path matches the owner's route only", () => {
	assert.equal(isOwnerProfilePath("/TestUser/", "testuser"), true);
	assert.equal(isOwnerProfilePath("/testuser", "testuser"), true);
	assert.equal(isOwnerProfilePath("/testuser/tagged/", "testuser"), false);
	assert.equal(isOwnerProfilePath("/", "testuser"), false);
});

// ─── The walk, over a fake page with the real capture script ─────────────

function post(id: string, likers = 1) {
	return { node: { id, taken_at: 1_700_000_000, like_count: likers,
		facepile_top_likers: Array.from({ length: likers }, (_, i) => ({ id: `${id}-l${i}`, username: `l${i}` })) } };
}

function timeline(ids: string[], endCursor: string | null, user: unknown = OWNER): unknown {
	return { data: { user, xdt_api__v1__feed__user_timeline_graphql_connection: {
		edges: ids.map((id) => post(id)),
		page_info: endCursor ? { has_next_page: true, end_cursor: endCursor } : { has_next_page: false, end_cursor: null },
	} } };
}

interface AppResponse {
	after: string | null;
	body: unknown;
	status?: number;
	username?: string;
	/** Send the request body as a stream, which the capture cannot read. */
	unreadable?: boolean;
}

function entry(after: string | null, body: unknown, options: Omit<AppResponse, "after" | "body"> = {}): AppResponse {
	return { after, body, ...options };
}

/** The app sends each posts request over XHR and receives its response. */
async function send(doc: FakeDocument, response: AppResponse): Promise<void> {
	const variables = {
		data: { count: 12 }, username: response.username ?? OWNER.username,
		...(response.after ? { after: response.after } : {}),
	};
	if (response.unreadable) {
		const stream = new ReadableStream();
		doc.xhr("POST", "/graphql/query", stream).finish(200, JSON.stringify(response.body));
		return;
	}
	doc.xhr("POST", "/graphql/query", postsForm(variables)).finish(response.status ?? 200, JSON.stringify(response.body));
}

/** `onOpen` and `onScroll[n]` are what the app sends when the profile view
 * opens and after the nth scroll. `reloadOnScroll` replaces the document.
 * With `initScripts`, the host runs the capture at document start. */
function fakeMobilePage(options: {
	onOpen: AppResponse[];
	onScroll?: AppResponse[][];
	overflow?: boolean;
	reloadOnScroll?: number;
	profileLink?: boolean;
	initScripts?: boolean;
}): Page & { calls: string[] } {
	const fake = createFakePage({ url: "about:blank", initScripts: options.initScripts === true });
	const calls: string[] = [];
	let scrolls = 0;
	const openProfileView = async (doc: FakeDocument): Promise<void> => {
		const location = doc.realm.location as { href: string; pathname: string };
		location.pathname = `/${OWNER.username}/`;
		location.href = `${ORIGIN}/${OWNER.username}/`;
		for (const response of options.onOpen) await send(doc, response);
		if (options.overflow) {
			for (let index = 0; index <= POSTS_CAPTURE_MAX_BUFFERED; index += 1) {
				await send(doc, entry("noise", { data: null }, { username: "someone_else" }));
			}
		}
	};
	const page = {
		calls,
		goto: async (url: string): Promise<null> => {
			const path = new URL(url).pathname;
			calls.push(`goto ${path}`);
			const doc = fake.navigate(url);
			if (path !== "/") await openProfileView(doc);
			await fake.settle();
			return null;
		},
		evaluate: async (code: unknown): Promise<unknown> => {
			const doc = fake.document;
			if (code === openProfileScript(OWNER.username, false) || code === openProfileScript(OWNER.username, true)) {
				if (options.profileLink === false) return { via: "none" };
				calls.push("open");
				await openProfileView(doc);
				await fake.settle();
				return { via: "link" };
			}
			if (code === POSTS_SCROLL_SCRIPT) {
				calls.push("scroll");
				scrolls += 1;
				let target = doc;
				if (options.reloadOnScroll === scrolls) target = fake.navigate(`${ORIGIN}/${OWNER.username}/`);
				for (const response of options.onScroll?.[scrolls - 1] ?? []) await send(target, response);
				await fake.settle();
				return { via: "scroll" };
			}
			// Everything else is the capture's own install or drain script.
			return await fake.evaluate(String(code));
		},
		...(fake.addInitScript ? {
			addInitScript: async (source: string) => {
				calls.push("addInitScript");
				await fake.addInitScript?.(source);
			},
		} : {}),
	};
	return page as unknown as Page & { calls: string[] };
}

const walk = (page: Page) => fetchAllPostsMobile(page, OWNER.username, null, undefined, NO_DELAY, FAST_CLOCK, OWNER.id);

test("walk: follows end_cursor page to page and proves the end", async () => {
	const page = fakeMobilePage({
		onOpen: [entry(null, timeline(["a", "b"], "c1"))],
		onScroll: [[entry("c1", timeline(["c"], null))]],
	});
	const result = await walk(page);
	assert.deepEqual(result.edges.map((edge) => edge.node.id), ["a", "b", "c"]);
	assert.equal(result.sourceEnd, true);
	assert.equal(result.ownerBound, true);
	assert.equal(result.sourceEdgeCount, 3);
	assert.equal(result.truncated, false);
	assert.deepEqual(page.calls, ["goto /", "open", "scroll"]);
});

test("walk: a page whose request cursor is not the previous end_cursor is never the next page", async () => {
	const page = fakeMobilePage({
		onOpen: [entry(null, timeline(["a"], "c1"))],
		// The app sends a stale cursor's page; c1 never comes.
		onScroll: [[entry("stale", timeline(["x"], null))]],
	});
	const result = await walk(page);
	assert.deepEqual(result.edges.map((edge) => edge.node.id), ["a", "x"]);
	assert.equal(result.sourceEnd, false);
});

test("walk: a queued later page is consumed in cursor order", async () => {
	const page = fakeMobilePage({
		onOpen: [entry("c1", timeline(["b"], null)), entry(null, timeline(["a"], "c1"))],
	});
	const result = await walk(page);
	assert.deepEqual(result.edges.map((edge) => edge.node.id), ["b", "a"]);
	assert.equal(result.sourceEnd, true);
	assert.deepEqual(page.calls, ["goto /", "open"]);
});

test("walk: another account's posts query is ignored, so the first page is not observed", async () => {
	const page = fakeMobilePage({ onOpen: [entry(null, timeline(["a"], null), { username: "someone_else" })] });
	await assert.rejects(walk(page), /^Error: meta_posts_response_not_observed/);
});

test("walk: no profile link is a failed navigation", async () => {
	const page = fakeMobilePage({ onOpen: [], profileLink: false });
	await assert.rejects(walk(page), /^Error: meta_posts_navigation_failed: no link to the profile/);
});

test("walk: a replaced document fails the walk and keeps the pages read", async () => {
	const page = fakeMobilePage({ onOpen: [entry(null, timeline(["a"], "c1"))], reloadOnScroll: 1 });
	await assert.rejects(walk(page), (error: Error & { partial?: unknown[] }) =>
		error.name === "PartialWalkFailure" && /^meta_posts_navigation_failed: the page was replaced/.test(error.message) &&
		error.partial?.length === 1);
});

// Each case keeps the posts read and names why the walk is unproven.
const unprovenCases: Array<{ label: string; page: () => Page; message: RegExp; kept: number }> = [
	{ label: "buffer overflowed", page: () => fakeMobilePage({ onOpen: [entry(null, timeline(["a"], null))], overflow: true }),
		message: /^meta_posts_observations_dropped: the page sent more/, kept: 1 },
	{ label: "unreadable posts-shaped request", page: () => fakeMobilePage({
		onOpen: [entry(null, timeline(["a"], "c1"))],
		onScroll: [[entry("c1", timeline(["b"], null)), entry(null, {}, { unreadable: true })]],
	}), message: /^meta_posts_observations_dropped: a posts-shaped request/, kept: 2 },
	{ label: "repeat omits a post", page: () => fakeMobilePage({
		onOpen: [entry(null, timeline(["a", "b"], "c1"))],
		onScroll: [[entry("c1", timeline(["c"], null)), entry(null, timeline(["a"], "c1"))]],
	}), message: /^meta_posts_timeline_contradictory/, kept: 3 },
	{ label: "repeat changes a post", page: () => fakeMobilePage({
		onOpen: [entry(null, timeline(["a"], null)), entry(null, { data: { user: OWNER,
			xdt_api__v1__feed__user_timeline_graphql_connection: { edges: [{ node: { ...post("a").node, like_count: 9 } }],
				page_info: { has_next_page: false, end_cursor: null } } } })],
	}), message: /^meta_posts_timeline_contradictory/, kept: 1 },
	{ label: "continuing page without cursor", page: () => fakeMobilePage({
		onOpen: [entry(null, { data: { user: OWNER, xdt_api__v1__feed__user_timeline_graphql_connection: {
			edges: [post("a")], page_info: { has_next_page: true, end_cursor: null } } } })],
	}), message: /^meta_posts_cursor_unavailable/, kept: 1 },
];
for (const c of unprovenCases) {
	test(`walk: an unproven observation keeps the posts read (${c.label})`, async () => {
		await assert.rejects(walk(c.page()), (error: Error & { partial?: unknown[] }) =>
			error.name === "PartialWalkFailure" && c.message.test(error.message) && error.partial?.length === c.kept);
	});
}

test("walk: an unsuccessful or foreign-owner first page is not a page", async () => {
	await assert.rejects(walk(fakeMobilePage({ onOpen: [entry(null, timeline(["a"], null), { status: 500 })] })),
		/^Error: meta_posts_timeline_unavailable/);
	await assert.rejects(walk(fakeMobilePage({ onOpen: [entry(null, timeline(["a"], null, { id: "other", username: "testuser" }))] })),
		/^Error: meta_posts_owner_conflict/);
	await assert.rejects(walk(fakeMobilePage({ onOpen: [entry(null, { errors: [{ message: "Authentication required" }] })] })),
		/^Error: meta_posts_timeline_unavailable/);
});

test("walk: a timeline without owner evidence is read but not owner-bound", async () => {
	const result = await walk(fakeMobilePage({ onOpen: [entry(null, timeline(["a"], null, null))] }));
	assert.equal(result.edges.length, 1);
	assert.equal(result.ownerBound, false);
});

test("walk, init-script host: loads the profile directly and reads its first page", async () => {
	const page = fakeMobilePage({
		initScripts: true,
		onOpen: [entry(null, timeline(["a", "b"], "c1"))],
		onScroll: [[entry("c1", timeline(["c"], null))]],
	});
	const result = await walk(page);
	assert.deepEqual(result.edges.map((edge) => edge.node.id), ["a", "b", "c"]);
	assert.equal(result.sourceEnd, true);
	assert.deepEqual(page.calls, ["addInitScript", "goto /testuser/", "scroll"]);
});

test("walk, init-script host: a reload during the walk still fails it", async () => {
	const page = fakeMobilePage({
		initScripts: true, onOpen: [entry(null, timeline(["a"], "c1"))], reloadOnScroll: 1,
		onScroll: [[entry("c1", timeline(["b"], null))]],
	});
	await assert.rejects(walk(page), (error: Error & { partial?: unknown[] }) =>
		error.name === "PartialWalkFailure" && /^meta_posts_navigation_failed: the page was replaced/.test(error.message));
});
