// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the LinkedIn connector's `collect()` layer —
 * proves the Collection Profile contract (scope filtering, RECORD then
 * STATE/DETAIL_COVERAGE ordering) without a real browser or a live
 * LinkedIn session.
 *
 * No browser is spun up. `page.goto`/`page.evaluate` are replaced by a
 * fake that serves canned Voyager JSON keyed by request path — the same
 * technique `connectors/reddit/integration.test.ts` uses for its fake
 * listing fetch. `collectLinkedIn` is driven directly through
 * `makeRecordingEmit(validateRecord)`, so every emitted record passes
 * through the real zod schema the production runtime applies.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserContext, Cookie, Page } from "playwright";
import type {
	BrowserCollectContext,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { collectLinkedIn, ensureLinkedInSession } from "./index.ts";
import { validateRecord } from "./schemas.ts";

const EMITTED_AT = "2026-09-22T12:00:00.000Z";

const ME_RESPONSE = {
	miniProfile: {
		occupation: "Staff Engineer at Acme",
		picture: {
			artifacts: [{ fileIdentifyingUrlPathSegment: "me-fallback.jpg" }],
			rootUrl: "https://media.example/me/",
		},
		publicIdentifier: "anon-member",
	},
};

const DASH_PROFILE_RESPONSE = {
	elements: [
		{
			firstName: "Anon",
			headline: "Staff Engineer at Acme",
			lastName: "Member",
			profileEducations: {
				elements: [
					{
						dateRange: { end: { year: 2015 }, start: { year: 2011 } },
						degreeName: "B.S.",
						fieldOfStudy: "Computer Science",
						grade: "3.9 GPA",
						school: {
							logo: {
								vectorImage: {
									artifacts: [{ fileIdentifyingUrlPathSegment: "logo.png" }],
									rootUrl: "https://media.example/school/",
								},
							},
						},
						schoolName: "State University",
					},
				],
			},
			profilePicture: {
				displayImageReference: {
					vectorImage: {
						artifacts: [{ fileIdentifyingUrlPathSegment: "dash.jpg" }],
						rootUrl: "https://media.example/dash/",
					},
				},
			},
			profileLanguages: {
				elements: [
					{ name: "Spanish", proficiency: "Professional working proficiency" },
				],
			},
			profilePositionGroups: {
				elements: [
					{
						company: { name: "Acme" },
						dateRange: { start: { month: 3, year: 2021 } },
						profilePositionInPositionGroup: {
							elements: [
								{
									companyName: "Acme",
									dateRange: { start: { month: 3, year: 2021 } },
									title: "Staff Engineer",
								},
							],
						},
					},
				],
			},
			profileSkills: {
				elements: [{ endorsementCount: 5, name: "Distributed Systems" }],
			},
			summary: "Builds reliable data infrastructure.",
		},
	],
};

const CONNECTIONS_PAGE_1 = {
	elements: [
		{
			connectedMember: "urn:li:fsd_profile:conn-1",
			createdAt: 1_700_000_000_000,
		},
	],
	paging: { total: 1 },
};

const RESOLVED_PROFILES = {
	results: {
		"urn:li:fsd_profile:conn-1": {
			firstName: "Jamie",
			headline: "PM at Acme",
			lastName: "Lee",
			publicIdentifier: "jamielee",
		},
	},
};

/** Route a Voyager request path to its canned response. Mirrors the shape
 *  `page.evaluate` returns in production: the parsed JSON body, or
 *  `{ _error }` for a failed/unhandled path. */
function routeVoyagerPath(path: string): unknown {
	if (path.startsWith("/voyager/api/me")) {
		return ME_RESPONSE;
	}
	if (path.startsWith("/voyager/api/identity/dash/profiles?q=memberIdentity")) {
		return DASH_PROFILE_RESPONSE;
	}
	if (path.startsWith("/voyager/api/relationships/dash/connections")) {
		return CONNECTIONS_PAGE_1;
	}
	if (path.startsWith("/voyager/api/identity/dash/profiles?ids=")) {
		return RESOLVED_PROFILES;
	}
	return { _error: `unhandled path: ${path}` };
}

function requestedMap(names: string[]): Map<string, StreamScope> {
	return new Map(names.map((name) => [name, { name }]));
}

/**
 * `voyagerFetch` in index.ts calls `page.evaluate(async ({ path }) => {...},
 * { path })` with a closure that references the page-global
 * `document`/`fetch`. Playwright's real `evaluate` runs that closure inside
 * the page, where those globals are the page's own; this fake shims them
 * onto the Node `globalThis` for the duration of the call so the real
 * `voyagerFetch` code path (CSRF-cookie parse, try/catch, `resp.ok` branch)
 * executes end to end rather than being bypassed by a path-level stub of
 * `voyagerFetch` itself.
 */
function makeFakePage(): Page {
	const fakeFetch = (path: string) => {
		const body = routeVoyagerPath(path);
		return Promise.resolve({
			json: () => Promise.resolve(body),
			ok: true,
			status: 200,
		});
	};

	return {
		evaluate: async (fn: unknown, arg: unknown) => {
			const g = globalThis as unknown as {
				document?: unknown;
				fetch?: unknown;
			};
			const priorDocument = g.document;
			const priorFetch = g.fetch;
			g.document = { cookie: 'JSESSIONID="ajax:1234567890"' };
			g.fetch = fakeFetch;
			try {
				const boundFn = fn as (a: unknown) => unknown;
				return await boundFn(arg);
			} finally {
				g.document = priorDocument;
				g.fetch = priorFetch;
			}
		},
		goto: async () => null,
	} as unknown as Page;
}

interface TestGlobalWithBrowserShims {
	document?: unknown;
	fetch?: unknown;
}

const NO_LINKEDIN_COOKIES: Cookie[] = [];

function evaluateVoyagerMe(liveSession: () => boolean) {
	return async (fn: unknown, arg: unknown) => {
		const g = globalThis as TestGlobalWithBrowserShims;
		const priorDocument = g.document;
		const priorFetch = g.fetch;
		g.document = { cookie: 'JSESSIONID="ajax:1234567890"' };
		g.fetch = async () => ({
			json: async () => (liveSession() ? ME_RESPONSE : {}),
			ok: liveSession(),
			status: liveSession() ? 200 : 401,
		});
		try {
			const boundFn = fn as (a: unknown) => unknown;
			return await boundFn(arg);
		} finally {
			g.document = priorDocument;
			g.fetch = priorFetch;
		}
	};
}

function buildCtx(
	requestedNames: string[],
	recording: ReturnType<typeof makeRecordingEmit>,
): BrowserCollectContext {
	return {
		assist: async (): Promise<never> => {
			throw new Error("assist not implemented in this test");
		},
		capture: null,
		completeAssistance: async () => undefined,
		context: {} as BrowserCollectContext["context"],
		credentials: {},
		detailGaps: [],
		emit: recording.emit,
		emitRecord: recording.emitRecord,
		emittedAt: EMITTED_AT,
		page: makeFakePage(),
		progress: async () => undefined,
		requestDetailGapPage: async (): Promise<readonly never[]> => [],
		requested: requestedMap(requestedNames),
		scope: { streams: requestedNames.map((name) => ({ name })) },
		sendInteraction: async (): Promise<never> => {
			throw new Error("sendInteraction not implemented in this test");
		},
		state: {},
	};
}

// ─── Session establishment ────────────────────────────────────────────────

test("ensureLinkedInSession: login becoming ready resumes without an interaction", async () => {
	const gotoUrls: string[] = [];
	const assistanceStatuses: string[] = [];
	let liveSession = false;
	const readinessPage = {
		close: async () => undefined,
		evaluate: evaluateVoyagerMe(() => liveSession),
		goto: async () => null,
	} as unknown as Page;
	const context = {
		cookies: async () =>
			liveSession ? [{ name: "li_at", value: "token" }] : [],
		newPage: async () => readinessPage,
	} as BrowserContext;
	const page = {
		context: () => context,
		evaluate: evaluateVoyagerMe(() => liveSession),
		goto: async (url: string) => {
			gotoUrls.push(url);
			return null;
		},
	} as Page;

	await ensureLinkedInSession({
		assist: async () => {
			liveSession = true;
			return "assistance-1";
		},
		capture: null,
		completeAssistance: async (_id, status) => {
			assistanceStatuses.push(status);
		},
		context,
		page,
		sendInteraction: async (): Promise<never> => {
			throw new Error("unexpected manual interaction");
		},
	});

	assert.deepEqual(assistanceStatuses, ["resolved"]);
	assert.deepEqual(gotoUrls, ["https://www.linkedin.com/login"]);
});

test("ensureLinkedInSession: readiness timeout escalates and fails safely", async () => {
	const assistanceStatuses: string[] = [];
	const context = {
		cookies: async () => NO_LINKEDIN_COOKIES,
		newPage: async () =>
			({
				close: async () => undefined,
				evaluate: evaluateVoyagerMe(() => false),
				goto: async () => null,
			}) as unknown as Page,
	} as BrowserContext;
	const page = {
		context: () => context,
		evaluate: evaluateVoyagerMe(() => false),
		goto: async () => null,
	} as unknown as Page;

	await assert.rejects(
		ensureLinkedInSession(
			{
				assist: async () => "assistance-timeout",
				capture: null,
				completeAssistance: async (_id, status) => {
					assistanceStatuses.push(status);
				},
				context,
				page,
				sendInteraction: async (): Promise<never> => {
					throw new Error("unexpected manual interaction");
				},
			},
			0,
		),
		/browser_handoff_readiness_timed_out/u,
	);
	assert.deepEqual(assistanceStatuses, ["escalated"]);
});

test("ensureLinkedInSession: login navigation failure rejects before manual handoff", async () => {
	let assistanceRequested = false;
	const context = {
		cookies: async () => NO_LINKEDIN_COOKIES,
	} as BrowserContext;
	const page = {
		context: () => context,
		evaluate: evaluateVoyagerMe(() => false),
		goto: (async (_url: string) => {
			throw new Error("navigation failed");
		}) as Page["goto"],
	} as Page;

	await assert.rejects(
		() =>
			ensureLinkedInSession({
				assist: async () => {
					assistanceRequested = true;
					return "unexpected";
				},
				capture: null,
				completeAssistance: async () => undefined,
				context,
				page,
				sendInteraction: async (): Promise<never> => {
					throw new Error("manualAction should be injected in this test");
				},
			}),
		/linkedin_login_page_unreachable/,
	);
	assert.equal(assistanceRequested, false);
});

test("ensureLinkedInSession: live session skips login handoff", async () => {
	const gotoUrls: string[] = [];
	let assistanceRequested = false;
	const context = {
		cookies: async () => [{ name: "li_at", value: "token" }],
	} as BrowserContext;
	const page = {
		context: () => context,
		evaluate: evaluateVoyagerMe(() => true),
		goto: async (url: string) => {
			gotoUrls.push(url);
			return null;
		},
	} as Page;

	await ensureLinkedInSession({
		assist: async () => {
			assistanceRequested = true;
			return "unexpected";
		},
		capture: null,
		completeAssistance: async () => undefined,
		context,
		page,
		sendInteraction: async (): Promise<never> => {
			throw new Error("manualAction should be injected in this test");
		},
	});

	assert.equal(assistanceRequested, false);
	assert.deepEqual(gotoUrls, ["https://www.linkedin.com/feed/"]);
});

// ─── Scope filtering ────────────────────────────────────────────────────

test("collectLinkedIn: requesting only 'profile' emits nothing for other streams", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const ctx = buildCtx(["profile"], recording);

	await collectLinkedIn(ctx);

	const streams = new Set(recording.emitted.map((r) => r.stream));
	assert.deepEqual([...streams], ["profile"]);
	assert.equal(recording.emitted.length, 1);
	assert.equal(recording.skipped.length, 0);
});

test("collectLinkedIn: requesting 'skills' + 'languages' emits only those two streams", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const ctx = buildCtx(["skills", "languages"], recording);

	await collectLinkedIn(ctx);

	const streams = new Set(recording.emitted.map((r) => r.stream));
	assert.deepEqual([...streams].sort(), ["languages", "skills"]);
});

test("collectLinkedIn: requesting no streams emits no records", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const ctx = buildCtx([], recording);

	await collectLinkedIn(ctx);

	assert.equal(recording.emitted.length, 0);
});

// ─── Full run: every stream, record shapes, coverage ordering ───────────

test("collectLinkedIn: full run emits a validated record for every requested stream", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const ctx = buildCtx(
		[
			"profile",
			"experience",
			"education",
			"skills",
			"languages",
			"connections",
		],
		recording,
	);

	await collectLinkedIn(ctx);

	assert.equal(recording.skipped.length, 0, JSON.stringify(recording.skipped));
	const byStream = new Map<string, number>();
	for (const r of recording.emitted) {
		byStream.set(r.stream, (byStream.get(r.stream) ?? 0) + 1);
	}
	assert.equal(byStream.get("profile"), 1);
	assert.equal(byStream.get("experience"), 1);
	assert.equal(byStream.get("education"), 1);
	assert.equal(byStream.get("skills"), 1);
	assert.equal(byStream.get("languages"), 1);
	assert.equal(byStream.get("connections"), 1);

	const profileRecord = recording.emitted.find(
		(r) => r.stream === "profile",
	)?.data;
	assert.equal(profileRecord?.id, "anon-member");
	assert.equal(profileRecord?.full_name, "Anon Member");
	assert.equal(profileRecord?.current_company, "Acme");
	assert.equal(profileRecord?.connection_count, 1);
	assert.equal(
		profileRecord?.profile_picture_url,
		"https://media.example/dash/dash.jpg",
	);

	const educationRecord = recording.emitted.find(
		(r) => r.stream === "education",
	)?.data;
	assert.equal(educationRecord?.grade, "3.9 GPA");
	assert.equal(
		educationRecord?.logo_url,
		"https://media.example/school/logo.png",
	);

	const connectionRecord = recording.emitted.find(
		(r) => r.stream === "connections",
	)?.data;
	assert.equal(connectionRecord?.id, "urn:li:fsd_profile:conn-1");
	assert.equal(connectionRecord?.full_name, "Jamie Lee");
});

test("collectLinkedIn: requesting only 'profile' still fetches connections for connection_count, without emitting connections records", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const ctx = buildCtx(["profile"], recording);

	await collectLinkedIn(ctx);

	const profileRecord = recording.emitted.find(
		(r) => r.stream === "profile",
	)?.data;
	assert.equal(profileRecord?.connection_count, 1);
	assert.equal(
		recording.emitted.some((r) => r.stream === "connections"),
		false,
		"connections stream itself must stay unrequested-silent even though its data was fetched for the count",
	);
});

test("collectLinkedIn: neither 'profile' nor 'connections' requested — no connections fetch happens at all", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const ctx = buildCtx(["experience"], recording);

	await collectLinkedIn(ctx);

	assert.equal(
		recording.emitted.some((r) => r.stream === "connections"),
		false,
	);
});

test("collectLinkedIn: DETAIL_COVERAGE for a stream is emitted after that stream's records", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const ctx = buildCtx(["skills"], recording);

	await collectLinkedIn(ctx);

	const recordIndex = recording.events.findIndex(
		(e) => e.kind === "record" && e.stream === "skills",
	);
	const coverageIndex = recording.events.findIndex(
		(e) =>
			e.kind === "message" &&
			e.message.type === "DETAIL_COVERAGE" &&
			e.message.stream === "skills",
	);
	assert.ok(recordIndex >= 0, "expected a skills RECORD event");
	assert.ok(coverageIndex >= 0, "expected a skills DETAIL_COVERAGE event");
	assert.ok(
		recordIndex < coverageIndex,
		"RECORD must be emitted before the coverage message that summarizes it",
	);
});

// ─── Session-dead terminal failure ────────────────────────────────────────

test("collectLinkedIn: no live session (me endpoint fails) throws a non-retryable, actionable error", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const ctx = buildCtx(["profile"], recording);
	// Override with a page whose fetch always fails auth, proving collect()
	// does not silently proceed on a dead session.
	const deadPage = {
		evaluate: async () => ({ _error: "http_401" }),
		goto: async () => null,
	} as unknown as Page;

	await assert.rejects(
		() => collectLinkedIn({ ...ctx, page: deadPage }),
		/linkedin_session_dead/,
	);
	assert.equal(recording.emitted.length, 0);
});
