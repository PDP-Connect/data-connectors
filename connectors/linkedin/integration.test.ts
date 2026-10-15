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
	EmittedMessage,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { collectLinkedIn, ensureLinkedInSession } from "./index.ts";
import { validateRecord } from "./schemas.ts";

const EMITTED_AT = "2026-09-22T12:00:00.000Z";

const ME_RESPONSE = {
	miniProfile: {
		firstName: "Anon",
		lastName: "Member",
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
					{
						entityUrn: "urn:li:language:spanish",
						name: "Spanish",
						proficiency: "Professional working proficiency",
					},
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
				elements: [
					{
						entityUrn: "urn:li:skill:distributed-systems",
						endorsementCount: 5,
						name: "Distributed Systems",
					},
				],
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
function makeFakePage(
	route: (path: string) => unknown = routeVoyagerPath,
): Page {
	const fakeFetch = (path: string) => {
		const body = route(path);
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
	route: (path: string) => unknown = routeVoyagerPath,
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
		page: makeFakePage(route),
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

function skipResults(recording: ReturnType<typeof makeRecordingEmit>) {
	return recording.protocolMessages.filter(
		(message): message is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
			message.type === "SKIP_RESULT",
	);
}

/** True when the stream reports every considered row covered: the evidence
 *  that would let a replacing collector delete rows it did not see. */
function claimsFullCoverage(
	recording: ReturnType<typeof makeRecordingEmit>,
	stream: string,
): boolean {
	return recording.protocolMessages.some(
		(message) =>
			message.type === "DETAIL_COVERAGE" &&
			message.stream === stream &&
			message.considered === message.covered,
	);
}

/** Field names a SKIP_RESULT reports as unavailable. */
function unavailableFieldsOf(skip: { diagnostics?: unknown }): string[] {
	const fields = (skip.diagnostics as { unavailable_fields?: unknown } | undefined)
		?.unavailable_fields;
	return fields && typeof fields === "object" ? Object.keys(fields).sort() : [];
}

// ─── Session establishment ────────────────────────────────────────────────

test("ensureLinkedInSession: read-only readiness probe uses the login tab", async () => {
	const gotoUrls: string[] = [];
	const assistanceStatuses: string[] = [];
	let liveSession = false;
	const context = {
		cookies: async () =>
			liveSession ? [{ name: "li_at", value: "token" }] : [],
		newPage: async () => {
			throw new Error("LinkedIn readiness must stay in the login tab");
		},
	} as unknown as BrowserContext;
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
	assert.ok(
		recording.protocolMessages.some(
			(message) =>
				message.type === "DETAIL_COVERAGE" &&
				message.stream === "connections",
		),
		"a verified end-of-list must authorize full connection inventory coverage",
	);
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

test("collectLinkedIn: dash failure keeps /me profile fields and reports unavailable dash details", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const route = (path: string): unknown => {
		if (path.startsWith("/voyager/api/me")) {
			return ME_RESPONSE;
		}
		if (path.startsWith("/voyager/api/relationships/dash/connections")) {
			return { elements: [], paging: { total: 0 } };
		}
		return { _error: "http_404" };
	};
	await collectLinkedIn(buildCtx(["profile"], recording, route));

	const profile = recording.emitted.find((event) => event.stream === "profile");
	assert.equal(profile?.data.full_name, "Anon Member");
	assert.equal(profile?.data.headline, "Staff Engineer at Acme");
	assert.equal(
		profile?.data.public_url,
		"https://www.linkedin.com/in/anon-member/",
	);
	assert.equal(
		profile?.data.profile_picture_url,
		"https://media.example/me/me-fallback.jpg",
	);
	assert.equal(
		claimsFullCoverage(recording, "profile"),
		false,
		"a profile with unavailable dash-backed fields must not claim full coverage",
	);
	assert.ok(
		skipResults(recording).some(
			(skip) => skip.reason === "linkedin_dash_profile_unavailable",
		),
	);
});

test("collectLinkedIn: a basic empty dash profile cannot prove profile coverage", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const route = (path: string): unknown => {
		if (path.startsWith("/voyager/api/me")) return ME_RESPONSE;
		if (path.includes("decorationId=")) return { _error: "http_404" };
		if (path.startsWith("/voyager/api/identity/dash/profiles?q=memberIdentity")) {
			return { elements: [{}] };
		}
		if (path.startsWith("/voyager/api/relationships/dash/connections")) {
			return { elements: [], paging: { total: 0 } };
		}
		return { _error: "http_404" };
	};
	await collectLinkedIn(buildCtx(["profile"], recording, route));

	const profile = recording.emitted.find((event) => event.stream === "profile");
	assert.equal(profile?.data.full_name, "Anon Member");
	assert.equal(profile?.data.headline, "Staff Engineer at Acme");
	assert.equal(claimsFullCoverage(recording, "profile"), false);
	assert.ok(
		skipResults(recording).some(
			(skip) =>
				skip.stream === "profile" &&
				skip.reason === "linkedin_profile_fields_unavailable",
		),
	);
});

test("collectLinkedIn: an empty decoration does not block a later usable decoration", async () => {
	const recording = makeRecordingEmit(validateRecord);
	let decorationAttempts = 0;
	const route = (path: string): unknown => {
		if (path.startsWith("/voyager/api/me")) return ME_RESPONSE;
		if (path.includes("decorationId=")) {
			decorationAttempts += 1;
			return decorationAttempts === 1
				? { elements: [{}] }
				: {
						elements: [
							{ firstName: "Decoration", lastName: "Two" },
						],
					};
		}
		if (path.startsWith("/voyager/api/relationships/dash/connections")) {
			return { elements: [], paging: { total: 0 } };
		}
		return { _error: "http_404" };
	};
	await collectLinkedIn(buildCtx(["profile"], recording, route));

	const profile = recording.emitted.find((event) => event.stream === "profile");
	assert.equal(profile?.data.full_name, "Decoration Two");
	assert.equal(decorationAttempts, 2);
});

test("collectLinkedIn: failed connection paging vetoes profile coverage", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const route = (path: string): unknown => {
		if (path.startsWith("/voyager/api/me")) return ME_RESPONSE;
		if (path.includes("decorationId=")) return DASH_PROFILE_RESPONSE;
		if (path.startsWith("/voyager/api/relationships/dash/connections")) {
			return { _error: "http_503" };
		}
		return { _error: "http_404" };
	};
	await collectLinkedIn(buildCtx(["profile"], recording, route));

	const profile = recording.emitted.find((event) => event.stream === "profile");
	// An unverified walk leaves connection_count out of the row (unavailable),
	// never `null` (which would claim "no connections").
	assert.equal(Object.hasOwn(profile?.data ?? {}, "connection_count"), false);
	assert.equal(claimsFullCoverage(recording, "profile"), false);
	assert.ok(
		skipResults(recording).some(
			(skip) =>
				skip.stream === "profile" &&
				unavailableFieldsOf(skip).includes("connection_count"),
		),
	);
});

test("collectLinkedIn: malformed connections page withholds coverage and exact count", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const route = (path: string): unknown => {
		if (path.startsWith("/voyager/api/me")) {
			return ME_RESPONSE;
		}
		if (
			path.startsWith("/voyager/api/identity/dash/profiles?q=memberIdentity")
		) {
			return DASH_PROFILE_RESPONSE;
		}
		if (path.startsWith("/voyager/api/relationships/dash/connections")) {
			return { paging: { total: 99 } };
		}
		return { _error: "http_404" };
	};
	await collectLinkedIn(buildCtx(["profile", "connections"], recording, route));

	const profile = recording.emitted.find((event) => event.stream === "profile");
	// An unverified walk leaves connection_count out of the row (unavailable),
	// never `null` (which would claim "no connections").
	assert.equal(Object.hasOwn(profile?.data ?? {}, "connection_count"), false);
	assert.equal(
		recording.events.some(
			(event) =>
				event.kind === "message" &&
			event.message.type === "DETAIL_COVERAGE" &&
				event.message.stream === "connections",
		),
		false,
		"a malformed listing page is not verified end-of-list evidence",
	);
	const malformedSkip = skipResults(recording).find(
		(skip) => skip.reason === "linkedin_connections_page_malformed",
	);
	assert.ok(malformedSkip);
	assert.deepEqual(malformedSkip.diagnostics, {
		termination_reason: "malformed_page",
		observed_count: 0,
		total: 99,
		missing_urn_count: 0,
	});
});

test("collectLinkedIn: repeated connection pages cannot prove a count or emit duplicate edges", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const route = (path: string): unknown => {
		if (path.startsWith("/voyager/api/me")) return ME_RESPONSE;
		if (path.startsWith("/voyager/api/relationships/dash/connections")) {
			const start = Number(
				new URL(path, "https://www.linkedin.com").searchParams.get("start"),
			);
			return {
				elements: Array.from({ length: 40 }, (_, index) => ({
					connectedMember: `urn:li:profile:${index}`,
				})),
				paging: { count: 40, start, total: 80 },
			};
		}
		if (path.startsWith("/voyager/api/identity/dash/profiles?ids=")) {
			const ids = decodeURIComponent(
				path.split("ids=List(")[1]?.split(")")[0] ?? "",
			).split(",");
			return {
				results: Object.fromEntries(
					ids.map((id) => [id, { firstName: `Member ${id.split(":").at(-1)}` }]),
				),
			};
		}
		return { _error: "http_404" };
	};
	await collectLinkedIn(buildCtx(["profile", "connections"], recording, route));

	const profile = recording.emitted.find((event) => event.stream === "profile");
	// An unverified walk leaves connection_count out of the row (unavailable),
	// never `null` (which would claim "no connections").
	assert.equal(Object.hasOwn(profile?.data ?? {}, "connection_count"), false);
	const connections = recording.emitted.filter(
		(event) => event.stream === "connections",
	);
	const ids = connections.map((event) => event.data.id);
	assert.equal(ids.length, 40);
	assert.equal(new Set(ids).size, ids.length);
	assert.equal(
		recording.protocolMessages.some(
			(message) =>
			message.type === "DETAIL_COVERAGE" &&
				message.stream === "connections",
		),
		false,
	);
});

test("collectLinkedIn: mismatched paging start vetoes connection completeness", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const route = (path: string): unknown => {
		if (path.startsWith("/voyager/api/me")) return ME_RESPONSE;
		if (path.startsWith("/voyager/api/relationships/dash/connections")) {
			return { elements: [], paging: { count: 40, start: 40, total: 0 } };
		}
		return { _error: "http_404" };
	};
	await collectLinkedIn(buildCtx(["profile", "connections"], recording, route));

	const profile = recording.emitted.find((event) => event.stream === "profile");
	// An unverified walk leaves connection_count out of the row (unavailable),
	// never `null` (which would claim "no connections").
	assert.equal(Object.hasOwn(profile?.data ?? {}, "connection_count"), false);
	assert.equal(
		recording.protocolMessages.some(
			(message) =>
				message.type === "DETAIL_COVERAGE" &&
				message.stream === "connections",
		),
		false,
	);
});

test("collectLinkedIn: a short reported full page cannot prove connection end", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const route = (path: string): unknown => {
		if (path.startsWith("/voyager/api/me")) return ME_RESPONSE;
		if (path.startsWith("/voyager/api/relationships/dash/connections")) {
			return {
				elements: Array.from({ length: 20 }, (_, index) => ({
					connectedMember: `urn:li:profile:short-page-${index}`,
				})),
				paging: { count: 20, start: 0 },
			};
		}
		return { _error: "http_404" };
	};
	await collectLinkedIn(buildCtx(["profile", "connections"], recording, route));

	const profile = recording.emitted.find((event) => event.stream === "profile");
	// An unverified walk leaves connection_count out of the row (unavailable),
	// never `null` (which would claim "no connections").
	assert.equal(Object.hasOwn(profile?.data ?? {}, "connection_count"), false);
	assert.equal(
		recording.protocolMessages.some(
			(message) =>
				message.type === "DETAIL_COVERAGE" && message.stream === "connections",
		),
		false,
		"a page whose advertised size differs from the request is not end evidence",
	);
});

test("collectLinkedIn: error-ended connections walk withholds full-scan coverage", async () => {
	const recording = makeRecordingEmit(validateRecord);
	let page = 0;
	const route = (path: string): unknown => {
		if (path.startsWith("/voyager/api/me")) {
			return ME_RESPONSE;
		}
		if (path.startsWith("/voyager/api/relationships/dash/connections")) {
			page += 1;
			return page === 1
				? {
						elements: Array.from({ length: 40 }, (_, index) => ({
							connectedMember: `urn:li:profile:${index}`,
						})),
					}
				: { _error: "http_503" };
		}
		if (path.startsWith("/voyager/api/identity/dash/profiles?ids=")) {
			const ids = decodeURIComponent(
				path.split("ids=List(")[1]?.split(")")[0] ?? "",
			).split(",");
			return {
				results: Object.fromEntries(
					ids.map((id) => [id, { firstName: "Member" }]),
				),
			};
		}
		return { _error: "http_404" };
	};
	await collectLinkedIn(buildCtx(["connections"], recording, route));
	assert.equal(
		recording.emitted.filter((event) => event.stream === "connections").length,
		40,
		"valid rows before a failed page remain available as partial records",
	);
	assert.equal(
		recording.events.some(
			(event) =>
				event.kind === "message" &&
			event.message.type === "DETAIL_COVERAGE" &&
				event.message.stream === "connections",
		),
		false,
	);
	const failedSkip = skipResults(recording).find(
		(skip) => skip.reason === "linkedin_connections_page_failed",
	);
	assert.ok(failedSkip);
	assert.deepEqual(failedSkip.diagnostics, {
		termination_reason: "page_error",
		observed_count: 40,
		total: null,
		missing_urn_count: 0,
		error: "http_503",
	});
});

test("collectLinkedIn: a failed member batch retries each URN as a singleton", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const batchRequests: string[] = [];
	const route = (path: string): unknown => {
		if (path.startsWith("/voyager/api/me")) {
			return ME_RESPONSE;
		}
		if (path.startsWith("/voyager/api/relationships/dash/connections")) {
			return {
				elements: [
					{ connectedMember: "urn:li:profile:a" },
					{ connectedMember: "urn:li:profile:b" },
				],
			};
		}
		if (path.startsWith("/voyager/api/identity/dash/profiles?ids=")) {
			batchRequests.push(path);
			if (path.includes(",")) {
				return { _error: "http_503" };
			}
			const urn = decodeURIComponent(
				path.split("ids=List(")[1]?.split(")")[0] ?? "",
			);
			return {
				results: { [urn]: { firstName: urn.endsWith(":a") ? "A" : "B" } },
			};
		}
		return { _error: "http_404" };
	};
	await collectLinkedIn(buildCtx(["connections"], recording, route));
	assert.equal(
		batchRequests.length,
		3,
		"one batch attempt plus one singleton attempt per URN",
	);
	assert.deepEqual(
		recording.emitted
			.filter((event) => event.stream === "connections")
			.map((event) => event.data.full_name),
		["A", "B"],
	);
});

test("collectLinkedIn: unreadable nested sections do not prove empty coverage", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const route = (path: string): unknown => {
		if (path.startsWith("/voyager/api/me")) {
			return ME_RESPONSE;
		}
		if (
			path.startsWith("/voyager/api/identity/dash/profiles?q=memberIdentity")
		) {
			return { elements: [{}] };
		}
		return { _error: "http_404" };
	};
	await collectLinkedIn(
		buildCtx(
			["experience", "education", "skills", "languages"],
			recording,
			route,
		),
	);
	for (const stream of ["experience", "education", "skills", "languages"]) {
		assert.equal(
			recording.events.some(
				(event) =>
					event.kind === "message" &&
					event.message.type === "DETAIL_COVERAGE" &&
					event.message.stream === stream,
			),
			false,
			`${stream} without a readable section must not claim an empty full scan`,
		);
		assert.ok(
			skipResults(recording).some(
				(skip) =>
					skip.stream === stream &&
					skip.reason === "linkedin_profile_section_unavailable",
			),
		);
	}
});

test("collectLinkedIn: empty sections on the basic-profile fallback are unavailable, not empty", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const route = (path: string): unknown => {
		if (path.startsWith("/voyager/api/me")) return ME_RESPONSE;
		if (path.includes("decorationId=")) return { _error: "http_404" };
		if (path.startsWith("/voyager/api/identity/dash/profiles?q=memberIdentity")) {
			return {
				elements: [
					{
						firstName: "Basic",
						lastName: "Fallback",
						profilePositionGroups: { elements: [] },
						profileEducations: { elements: [] },
						profileSkills: { elements: [] },
						profileLanguages: { elements: [] },
					},
				],
			};
		}
		return { _error: "http_404" };
	};
	await collectLinkedIn(
		buildCtx(["experience", "education", "skills", "languages"], recording, route),
	);

	for (const stream of ["experience", "education", "skills", "languages"]) {
		assert.equal(
			recording.protocolMessages.some(
				(message) => message.type === "DETAIL_COVERAGE" && message.stream === stream,
			),
			false,
			`${stream} on a basic profile cannot prove an empty inventory`,
		);
		assert.ok(
			skipResults(recording).some(
				(skip) => skip.stream === stream && skip.reason === "linkedin_profile_section_unavailable",
			),
		);
	}
});

test("collectLinkedIn: unreadable experience and education rows stay uncovered", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const progressMessages: string[] = [];
	const route = (path: string): unknown => {
		if (path.startsWith("/voyager/api/me")) return ME_RESPONSE;
		if (path.includes("decorationId=")) {
			return {
				elements: [
					{
						profileEducations: { elements: [17] },
						profilePositionGroups: {
							elements: [
								17,
								{
									company: { name: "Synthetic company" },
									profilePositionInPositionGroup: { elements: {} },
								},
							],
						},
					},
				],
			};
		}
		return { _error: "http_404" };
	};
	const ctx = buildCtx(["experience", "education"], recording, route);
	await collectLinkedIn({
		...ctx,
		progress: async (message) => {
			progressMessages.push(message);
		},
	});

	assert.equal(
		recording.emitted.filter((event) => event.stream === "experience").length,
		0,
	);
	assert.equal(
		recording.emitted.filter((event) => event.stream === "education").length,
		0,
	);
	const coverage = recording.protocolMessages.filter(
		(message): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
			message.type === "DETAIL_COVERAGE",
	);
	assert.deepEqual(
		coverage.map(({ stream, considered, covered }) => ({
			stream,
			considered,
			covered,
		})),
		[
			{ stream: "experience", considered: 2, covered: 0 },
			{ stream: "education", considered: 1, covered: 0 },
		],
	);
	assert.ok(
		progressMessages.some((message) => message.includes("malformed_row=1")),
	);
	assert.ok(
		progressMessages.some((message) =>
			message.includes("unreadable_nested_collection=1"),
		),
	);
});

test("collectLinkedIn: malformed mapped experience and education values stay uncovered", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const progressMessages: string[] = [];
	const route = (path: string): unknown => {
		if (path.startsWith("/voyager/api/me")) return ME_RESPONSE;
		if (path.includes("decorationId=")) {
			return {
				elements: [
					{
						profilePositionGroups: {
							elements: [
								{ title: 42 },
								{
									profilePositionInPositionGroup: {
										elements: [{ title: "Readable", dateRange: { start: 17 } }],
									},
								},
							],
						},
						profileEducations: {
							elements: [
								{ schoolName: { text: "Unreadable school" } },
								{ schoolName: "Readable", dateRange: { start: { year: "2020" } } },
							],
						},
					},
				],
			};
		}
		return { _error: "http_404" };
	};
	const ctx = buildCtx(["experience", "education"], recording, route);
	await collectLinkedIn({
		...ctx,
		progress: async (message) => {
			progressMessages.push(message);
		},
	});

	for (const stream of ["experience", "education"]) {
		const coverage = recording.protocolMessages.find(
			(message): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
				message.type === "DETAIL_COVERAGE" && message.stream === stream,
		);
		assert.equal(coverage?.considered, 2);
		assert.equal(coverage?.covered, 0);
		// The row with no readable field is not emitted. The row with a
		// readable title or school is emitted without its unreadable date.
		const rows = recording.emitted.filter((event) => event.stream === stream);
		assert.equal(rows.length, 1);
		assert.equal(Object.hasOwn(rows[0]?.data ?? {}, "start_date"), false);
		assert.ok(
			skipResults(recording).some(
				(skip) =>
					skip.stream === stream &&
					skip.reason === "linkedin_fields_unreadable" &&
					unavailableFieldsOf(skip).includes("start_date"),
			),
		);
	}
	assert.equal(
		progressMessages.filter((message) => message.includes("no_readable_content=1"))
			.length,
		2,
	);
});

test("collectLinkedIn: malformed profile mappings stay unavailable without crashing section collection", async () => {
	await Promise.all([
		{ elements: {} },
		{
			elements: [
				{ profilePositionInPositionGroup: { elements: {} } },
			],
		},
		{
			elements: [
				{ profilePositionInPositionGroup: { elements: [] } },
			],
		},
	].map(async (malformedGroups) => {
		const recording = makeRecordingEmit(validateRecord);
		const route = (path: string): unknown => {
			if (path.startsWith("/voyager/api/me")) return ME_RESPONSE;
			if (path.includes("decorationId=")) {
				return {
					elements: [
						{
							firstName: "Decoration",
							lastName: "Member",
							profilePositionGroups: malformedGroups,
							industry: null,
							geoLocation: { geo: { defaultLocalizedName: 42 } },
							summary: null,
							profileEducations: { elements: [] },
							profileSkills: { elements: [] },
							profileLanguages: { elements: [] },
						},
					],
				};
			}
			if (path.startsWith("/voyager/api/relationships/dash/connections")) {
				return { elements: [], paging: { total: 0 } };
			}
			return { _error: "http_404" };
		};
		await assert.doesNotReject(
			collectLinkedIn(
				buildCtx(
					["profile", "experience", "education", "skills", "languages"],
					recording,
					route,
				),
			),
		);
		const profile = recording.emitted.find((event) => event.stream === "profile");
		assert.equal(profile?.data.full_name, "Decoration Member");
		assert.equal(claimsFullCoverage(recording, "profile"), false);
		const experienceCoverage = recording.protocolMessages.find(
			(message): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
				message.type === "DETAIL_COVERAGE" && message.stream === "experience",
		);
		if (Array.isArray(malformedGroups.elements)) {
			assert.equal(experienceCoverage?.covered, 0);
		} else {
			assert.equal(experienceCoverage, undefined);
		}
		assert.ok(
			skipResults(recording).some(
				(skip) => skip.stream === "profile" && skip.reason === "linkedin_profile_fields_unavailable",
			),
		);
	}));
});

test("collectLinkedIn: malformed current-position and location values veto profile coverage", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const route = (path: string): unknown => {
		if (path.startsWith("/voyager/api/me")) return ME_RESPONSE;
		if (path.includes("decorationId=")) {
			return {
				elements: [
					{
						firstName: "Decoration",
						lastName: "Member",
						profilePositionGroups: { elements: [{ title: 42 }] },
						industry: null,
						geoLocation: { geo: { defaultLocalizedName: 42 } },
						summary: null,
					},
				],
			};
		}
		if (path.startsWith("/voyager/api/relationships/dash/connections")) {
			return { elements: [], paging: { total: 0 } };
		}
		return { _error: "http_404" };
	};
	await collectLinkedIn(buildCtx(["profile"], recording, route));

	const profile = recording.emitted.find((event) => event.stream === "profile");
	assert.equal(profile?.data.full_name, "Decoration Member");
	assert.equal(claimsFullCoverage(recording, "profile"), false);
	const profileSkip = skipResults(recording).find(
		(skip) => skip.reason === "linkedin_profile_fields_unavailable",
	);
	assert.ok(profileSkip);
	// The current group has no company source at all (explicit empty); only
	// its malformed title and the malformed location are unreadable.
	assert.deepEqual(unavailableFieldsOf(profileSkip), [
		"current_position_title",
		"location",
	]);
	assert.equal(profile?.data.current_company, null);
});

test("collectLinkedIn: readable empty sections prove an empty inventory", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const route = (path: string): unknown => {
		if (path.startsWith("/voyager/api/me")) {
			return ME_RESPONSE;
		}
		if (
			path.startsWith("/voyager/api/identity/dash/profiles?q=memberIdentity")
		) {
			return {
				elements: [
					{
						profilePositionGroups: { elements: [] },
						profileEducations: { elements: [] },
						profileSkills: { elements: [] },
						profileLanguages: { elements: [] },
					},
				],
			};
		}
		return { _error: "http_404" };
	};
	await collectLinkedIn(
		buildCtx(
			["experience", "education", "skills", "languages"],
			recording,
			route,
		),
	);
	for (const stream of ["experience", "education", "skills", "languages"]) {
		const coverage = recording.protocolMessages.find(
			(
				message,
			): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
				message.type === "DETAIL_COVERAGE" && message.stream === stream,
		);
		assert.equal(coverage?.considered, 0);
		assert.equal(coverage?.covered, 0);
	}
	assert.equal(skipResults(recording).length, 0);
});

test("collectLinkedIn: skill/language malformed rows preserve values and omit rows without source identity", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const progressMessages: string[] = [];
	const route = (path: string): unknown => {
		if (path.startsWith("/voyager/api/me")) {
			return ME_RESPONSE;
		}
		if (
			path.startsWith("/voyager/api/identity/dash/profiles?q=memberIdentity")
		) {
			return {
				elements: [
					{
						profileSkills: {
							elements: [
								{
									entityUrn: "urn:li:skill:blank",
									name: " ",
									endorsements: "7",
								},
								{ name: "No identity", endorsements: 1 },
							],
						},
						profileLanguages: {
							elements: [
								{
									entityUrn: "urn:li:language:blank",
									name: "",
									proficiency: "Full professional",
								},
								{ name: "No identity", proficiency: "Native" },
							],
						},
					},
				],
			};
		}
		return { _error: "http_404" };
	};
	const ctx = buildCtx(["skills", "languages"], recording, route);
	await collectLinkedIn({
		...ctx,
		progress: async (message) => {
			progressMessages.push(message);
		},
	});

	const skill = recording.emitted.find((event) => event.stream === "skills");
	assert.equal(skill?.data.id, "urn:li:skill:blank");
	assert.equal(skill?.data.name, " ");
	assert.equal(skill?.data.endorsement_count, 7);
	const language = recording.emitted.find(
		(event) => event.stream === "languages",
	);
	assert.equal(language?.data.id, "urn:li:language:blank");
	assert.equal(language?.data.name, "");
	assert.equal(language?.data.proficiency, "Full professional");
	for (const stream of ["skills", "languages"]) {
		const coverage = recording.protocolMessages.find(
			(
				message,
			): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
				message.type === "DETAIL_COVERAGE" && message.stream === stream,
		);
		assert.equal(coverage?.considered, 2);
		assert.equal(coverage?.covered, 1);
	}
	assert.ok(
		progressMessages.some((message) =>
			message.includes("id_absent=1"),
		),
	);
});

test("collectLinkedIn: connection rows without URNs and unresolved enrichment are reported without invented ids", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const progressMessages: string[] = [];
	const route = (path: string): unknown => {
		if (path.startsWith("/voyager/api/me")) {
			return ME_RESPONSE;
		}
		if (path.startsWith("/voyager/api/relationships/dash/connections")) {
			return {
				elements: [
					{ connectedMember: "" },
					{ connectedMember: "urn:li:profile:unresolved" },
				],
			};
		}
		if (path.startsWith("/voyager/api/identity/dash/profiles?ids=")) {
			return { _error: "http_503" };
		}
		return { _error: "http_404" };
	};
	const ctx = buildCtx(["connections"], recording, route);
	await collectLinkedIn({
		...ctx,
		progress: async (message) => {
			progressMessages.push(message);
		},
	});

	const connections = recording.emitted.filter(
		(event) => event.stream === "connections",
	);
	assert.equal(connections.length, 1);
	assert.equal(connections[0]?.data.id, "urn:li:profile:unresolved");
	const coverage = recording.protocolMessages.find(
		(
			message,
		): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
			message.type === "DETAIL_COVERAGE" && message.stream === "connections",
	);
	assert.equal(coverage, undefined, "an omitted source row vetoes full coverage");
	assert.ok(
		skipResults(recording).some(
			(skip) => skip.reason === "linkedin_connections_page_malformed",
		),
	);
	assert.ok(
		progressMessages.some((message) =>
			message.includes("missing_connected_member_urn=1"),
		),
	);
	assert.ok(
		progressMessages.some((message) =>
			message.includes("enrichment unresolved: 1"),
		),
	);
});

test("collectLinkedIn: partial batches retry missing URNs and validate sourced string fields", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const progressMessages: string[] = [];
	const urns = [
		"urn:li:profile:blank",
		"urn:li:profile:malformed",
		"urn:li:profile:missing",
	];
	const singletonRequests: string[] = [];
	const route = (path: string): unknown => {
		if (path.startsWith("/voyager/api/me")) return ME_RESPONSE;
		if (path.startsWith("/voyager/api/relationships/dash/connections")) {
			return { elements: urns.map((connectedMember) => ({ connectedMember })) };
		}
		if (path.startsWith("/voyager/api/identity/dash/profiles?ids=")) {
			const ids = decodeURIComponent(
				path.split("ids=List(")[1]?.split(")")[0] ?? "",
			).split(",");
			if (ids.length > 1) {
				return {
					results: {
						[urns[0] as string]: {
							firstName: "",
							headline: "",
							lastName: "",
						},
						[urns[1] as string]: { firstName: 123 },
					},
				};
			}
			singletonRequests.push(ids[0] ?? "");
			if (ids[0] === urns[1]) {
				return { results: { [urns[1] as string]: { firstName: 123 } } };
			}
			return { elements: [{ entityUrn: urns[2], lastName: "Only" }] };
		}
		return { _error: "http_404" };
	};
	const ctx = buildCtx(["connections"], recording, route);
	await collectLinkedIn({
		...ctx,
		progress: async (message) => {
			progressMessages.push(message);
		},
	});

	assert.deepEqual(singletonRequests, [urns[1], urns[2]]);
	const connections = recording.emitted.filter(
		(event) => event.stream === "connections",
	);
	assert.deepEqual(
		connections.map((event) => [
			event.data.id,
			event.data.full_name,
			event.data.headline,
		]),
		[
			[urns[0], "", ""],
			// The numeric first name is unreadable, so full_name is left out.
			[urns[1], undefined, null],
			[urns[2], "Only", null],
		],
	);
	const coverage = recording.protocolMessages.find(
		(message): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
			message.type === "DETAIL_COVERAGE" && message.stream === "connections",
	);
	assert.equal(coverage?.considered, 3);
	assert.equal(coverage?.covered, 2);
	assert.ok(
		progressMessages.some((message) =>
			message.includes("malformed_enrichment=1"),
		),
	);
});

test("collectLinkedIn: batch array enrichment admits source-backed last-name-only values", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const urn = "urn:li:profile:last-name-only";
	const route = (path: string): unknown => {
		if (path.startsWith("/voyager/api/me")) return ME_RESPONSE;
		if (path.startsWith("/voyager/api/relationships/dash/connections")) {
			return { elements: [{ connectedMember: urn }] };
		}
		if (path.startsWith("/voyager/api/identity/dash/profiles?ids=")) {
			return { elements: [{ entityUrn: urn, lastName: "Only" }] };
		}
		return { _error: "http_404" };
	};
	await collectLinkedIn(buildCtx(["connections"], recording, route));

	const record = recording.emitted.find((event) => event.stream === "connections");
	assert.equal(record?.data.full_name, "Only");
	const coverage = recording.protocolMessages.find(
		(message): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
			message.type === "DETAIL_COVERAGE" && message.stream === "connections",
	);
	assert.equal(coverage?.considered, 1);
	assert.equal(coverage?.covered, 1);
});

test("collectLinkedIn: singleton enrichment preserves source-backed blanks in map and array forms", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const urns = ["urn:li:profile:blank-map", "urn:li:profile:blank-array"];
	const singletonRequests: string[] = [];
	const route = (path: string): unknown => {
		if (path.startsWith("/voyager/api/me")) return ME_RESPONSE;
		if (path.startsWith("/voyager/api/relationships/dash/connections")) {
			return { elements: urns.map((connectedMember) => ({ connectedMember })) };
		}
		if (path.startsWith("/voyager/api/identity/dash/profiles?ids=")) {
			const ids = decodeURIComponent(
				path.split("ids=List(")[1]?.split(")")[0] ?? "",
			).split(",");
			if (ids.length > 1) return { _error: "http_503" };
			singletonRequests.push(ids[0] ?? "");
			if (ids[0] === urns[0]) {
				return { results: { [urns[0] as string]: { firstName: "" } } };
			}
			return { elements: [{ entityUrn: urns[1], lastName: "" }] };
		}
		return { _error: "http_404" };
	};
	await collectLinkedIn(buildCtx(["connections"], recording, route));

	assert.deepEqual(singletonRequests, urns);
	assert.deepEqual(
		recording.emitted
			.filter((event) => event.stream === "connections")
			.map((event) => [event.data.id, event.data.full_name]),
		[
			[urns[0], ""],
			[urns[1], ""],
		],
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
