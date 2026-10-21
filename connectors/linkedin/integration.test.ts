// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the LinkedIn connector's `collect()` layer —
 * proves the Collection Profile contract (scope filtering, RECORD then
 * UPSERT-ONLY coverage gaps) without a real browser or a live
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
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { BrowserContext, Cookie, Page } from "playwright";
import type {
	BrowserCollectContext,
	EmittedMessage,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { makeEmitRecord } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { collectLinkedIn, ensureLinkedInSession } from "./index.ts";
import { validateRecord } from "./schemas.ts";

const EMITTED_AT = "2026-09-22T12:00:00.000Z";

test("resource selection keeps a proved LinkedIn inventory successful without claiming a global checkpoint", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const ctx = buildCtx(["skills"], recording, (path) => {
		if (!path.includes("memberIdentity=")) return routeVoyagerPath(path);
		const response = structuredClone(DASH_PROFILE_RESPONSE);
		const profile = response.elements[0];
		assert.ok(profile);
		Object.assign(profile, { entityUrn: "urn:li:fsd_profile:12", publicIdentifier: "anon-member" });
		profile.profileSkills.elements.push({ entityUrn: "urn:li:skill:other", endorsementCount: 1, name: "Other" });
		profile.profileSkills.paging.total = 2;
		profile.profileSkills.paging.count = 2;
		return response;
	});
	ctx.requested.set("skills", { name: "skills", resources: ["urn:li:skill:distributed-systems"] });
	const messages: EmittedMessage[] = [];
	const gate = makeEmitRecord({ requested: ctx.requested, emit: async (message) => { messages.push(message); },
		emittedAt: EMITTED_AT, validateRecord, isTombstone: undefined, timeRangeFieldFor: () => null });
	ctx.emitRecord = gate.emit;
	ctx.isRecordSelected = gate.isSelected;
	await collectLinkedIn(ctx);
	assert.deepEqual(messages.filter(message => message.type === "RECORD").map(message => message.data.id), ["urn:li:skill:distributed-systems"]);
	assert.deepEqual(skipResults(recording), []);
	assert.equal(recording.protocolMessages.some(message => message.type === "STATE"), false);
});

for (const status of [401, 403, 429, 503]) {
	test(`section-only dash failure preserves HTTP ${status} as a failed read or rejected session`, async () => {
		const recording = makeRecordingEmit(validateRecord);
		const ctx = buildCtx(["experience"], recording, (path) => path.includes("memberIdentity=")
			? { _error: `http_${status}` } : routeVoyagerPath(path));
		if (status === 401 || status === 403) {
			await assert.rejects(collectLinkedIn(ctx), /linkedin_session_dead:/);
			assert.deepEqual(skipResults(recording), []);
		} else {
			await collectLinkedIn(ctx);
			assert.deepEqual(skipResults(recording).map(skip => ({ reason: skip.reason, hint: skip.recovery_hint })), [{
				reason: "stream_collection_failed", hint: { action: "retry_by_runtime", retryable: true },
			}]);
		}
		assert.equal(recording.protocolMessages.some(message => message.type === "STATE"), false);
	});
}

test("resource selection of connections does not become missing enrichment", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const ctx = buildCtx(["connections"], recording, (path) => {
		if (path.includes("connectionsSummary")) return { ...PROOF_SUMMARY, numConnections: 2 };
		if (path.includes("/connections?")) {
			const start = new URL(path, "https://www.linkedin.com").searchParams.get("start");
			return { elements: start === "0" ? [CONNECTIONS_PAGE_1.elements[0], { connectedMember: "urn:li:fsd_profile:conn-2", createdAt: 1_700_000_000_000 }] : [] };
		}
		if (path.includes("profiles?ids=")) return { results: { ...RESOLVED_PROFILES.results,
			"urn:li:fsd_profile:conn-2": { ...RESOLVED_PROFILES.results["urn:li:fsd_profile:conn-1"], publicIdentifier: "other" } } };
		return routeVoyagerPath(path);
	});
	ctx.requested.set("connections", { name: "connections", resources: ["urn:li:fsd_profile:conn-1"] });
	const messages: EmittedMessage[] = [];
	const gate = makeEmitRecord({ requested: ctx.requested, emit: async (message) => { messages.push(message); },
		emittedAt: EMITTED_AT, validateRecord, isTombstone: undefined, timeRangeFieldFor: () => null });
	ctx.emitRecord = gate.emit;
	ctx.isRecordSelected = gate.isSelected;
	await collectLinkedIn(ctx);
	assert.deepEqual(messages.filter(message => message.type === "RECORD").map(message => message.data.id), ["urn:li:fsd_profile:conn-1"]);
	assert.deepEqual(skipResults(recording), []);
	assert.equal(recording.protocolMessages.some(message => message.type === "STATE"), false);
});

const ME_RESPONSE = {
	plainId: 12,
	miniProfile: {
		entityUrn: "urn:li:fs_miniProfile:12",
		dashEntityUrn: "urn:li:fsd_profile:12",
		objectUrn: "urn:li:member:12",
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
			// Every profile field is readable, so the profile row is covered and
			// emitted (an uncovered row is withheld whole).
			geoLocation: { geo: { defaultLocalizedName: "Austin, Texas, United States" } },
			headline: "Staff Engineer at Acme",
			industry: { name: "Software Development" },
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
				paging: { count: 1, start: 0, total: 1 },
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
				paging: { count: 1, start: 0, total: 1 },
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
							paging: { count: 1, start: 0, total: 1 },
						},
					},
				],
				paging: { count: 1, start: 0, total: 1 },
			},
			profileSkills: {
				elements: [
					{
						entityUrn: "urn:li:skill:distributed-systems",
						endorsementCount: 5,
						name: "Distributed Systems",
					},
				],
				paging: { count: 1, start: 0, total: 1 },
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

const CONNECTION_ENRICHMENT_NOT_FOUND = JSON.parse(
	readFileSync(
		new URL("./fixtures/scrubbed/connection-enrichment-not-found.json", import.meta.url),
		"utf8",
	),
) as {
	listing: { elements: unknown[] };
	profileLookup: unknown;
};

/** Route a Voyager request path to its canned response. Mirrors the shape
 *  `page.evaluate` returns in production: the parsed JSON body, or
 *  `{ _error }` for a failed/unhandled path. */
function routeVoyagerPath(path: string): unknown {
	if (path === "/voyager/api/relationships/connectionsSummary/") return { entityUrn: "urn:li:fsd_connectionsSummary:12", numConnections: 1 };
	if (path.startsWith("/voyager/api/me")) {
		return ME_RESPONSE;
	}
	if (path.startsWith("/voyager/api/identity/dash/profiles?q=memberIdentity")) {
		return DASH_PROFILE_RESPONSE;
	}
	if (path.startsWith("/voyager/api/relationships/dash/connections")) {
		return path.endsWith("&start=1") ? { elements: [], paging: { start: 1, total: 1 } } : CONNECTIONS_PAGE_1;
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
	const markFixtureCollectionsComplete = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(markFixtureCollectionsComplete);
		if (typeof value !== "object" || value === null) return value;
		const collection = Object.fromEntries(
			Object.entries(value).map(([key, child]) => [
				key,
				markFixtureCollectionsComplete(child),
			]),
		);
		return Array.isArray(collection.elements) && !Object.hasOwn(collection, "paging")
			? { ...collection, paging: { start: 0, total: collection.elements.length } }
			: collection;
	};
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
		page: makeFakePage((path) => {
			const response = route(path);
			return path.startsWith("/voyager/api/identity/dash/profiles?q=memberIdentity")
				? markFixtureCollectionsComplete(response)
				: response;
		}),
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

function diagnosticsOf(skip: { diagnostics?: unknown }): Record<string, unknown> {
	return (skip.diagnostics ?? {}) as Record<string, unknown>;
}

/** Field names a SKIP_RESULT reports as unavailable. */
function unavailableFieldsOf(skip: { diagnostics?: unknown }): string[] {
	const fields = (skip.diagnostics as { unavailable_fields?: unknown } | undefined)
		?.unavailable_fields;
	return fields && typeof fields === "object" ? Object.keys(fields).sort() : [];
}

/** Asserts the stream emitted no row (an uncovered row is withheld whole,
 *  since a partial upsert would erase stored values) and returns the field
 *  names its gaps report as unavailable. */
function withheldFieldsOf(
	recording: ReturnType<typeof makeRecordingEmit>,
	stream: string,
): string[] {
	assert.deepEqual(
		recording.emitted.filter((event) => event.stream === stream),
		[],
		`${stream}: an uncovered row was emitted`,
	);
	assert.deepEqual(
		recording.skipped.filter((record) => record.stream === stream),
		[],
		`${stream}: a partial row was emitted`,
	);
	assert.equal(claimsFullCoverage(recording, stream), false);
	return [
		...new Set(
			skipResults(recording)
				.filter((skip) => skip.stream === stream)
				.flatMap(unavailableFieldsOf),
		),
	].sort();
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
	assert.equal(claimsFullCoverage(recording, "connections"), true);
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

test("collectLinkedIn: canonical gap for a stream is emitted after that stream's records", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const ctx = buildCtx(["skills"], recording);

	await collectLinkedIn(ctx);

	const recordIndex = recording.events.findIndex(
		(e) => e.kind === "record" && e.stream === "skills",
	);
	const coverageIndex = recording.events.findIndex(
		(e) =>
			e.kind === "message" &&
			e.message.type === "SKIP_RESULT" &&
			e.message.stream === "skills",
	);
	assert.ok(recordIndex >= 0, "expected a skills RECORD event");
	assert.ok(coverageIndex >= 0, "expected a skills SKIP_RESULT event");
	assert.ok(
		recordIndex < coverageIndex,
		"RECORD must be emitted before the coverage message that summarizes it",
	);
});

test("collectLinkedIn: keeps a listed connection when its profile lookup returns per-member 404", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const route = (path: string): unknown => {
		if (path === "/voyager/api/relationships/connectionsSummary/") {
			return { entityUrn: "urn:li:fsd_connectionsSummary:12", numConnections: 1 };
		}
		if (path.startsWith("/voyager/api/me")) return ME_RESPONSE;
		if (path.startsWith("/voyager/api/relationships/dash/connections")) {
			const start = Number(new URL(path, "https://www.linkedin.com").searchParams.get("start"));
			return start === 0
				? CONNECTION_ENRICHMENT_NOT_FOUND.listing
				: { elements: [], paging: { count: 40, start, links: [] } };
		}
		if (path.startsWith("/voyager/api/identity/dash/profiles?ids=")) {
			return CONNECTION_ENRICHMENT_NOT_FOUND.profileLookup;
		}
		return { _error: "http_404" };
	};
	await collectLinkedIn(buildCtx(["connections"], recording, route));

	const connection = recording.emitted.find((row) => row.stream === "connections");
	assert.deepEqual(connection?.data, {
		connected_at: "2023-11-14T22:13:20.000Z",
		id: "urn:li:fsd_profile:synthetic-member-001",
	});
	assert.equal(claimsFullCoverage(recording, "connections"), true);
});

test("collectLinkedIn: transient or malformed connection rows preserve prior upserts", async () => {
	for (const scenario of [
		{
			name: "profile lookup 503",
			options: { resolution: { _error: "http_503" } },
			shouldEmitEdge: false,
		},
		{
			name: "malformed createdAt",
			options: { connections: { elements: [{ connectedMember: "urn:li:fsd_profile:conn-1", createdAt: "bad" }] } },
			shouldEmitEdge: false,
		},
		{
			name: "per-member 404",
			options: { resolution: { errors: { "urn:li:fsd_profile:conn-1": { status: 404 } } } },
			shouldEmitEdge: true,
		},
	] as const) {
		const first = await collectProof();
		const stored = new Map(
			first.recording.emitted
				.filter((record) => record.stream === "connections")
				.map((record) => [record.data.id as string, structuredClone(record.data)]),
		);
		const prior = structuredClone(stored.get("urn:li:fsd_profile:conn-1"));
		assert.deepEqual(prior, {
			connected_at: "2023-11-14T22:13:20.000Z",
			full_name: "Jamie Lee",
			headline: "PM at Acme",
			id: "urn:li:fsd_profile:conn-1",
			profile_url: "https://www.linkedin.com/in/jamielee/",
		});

		const second = await collectProof(scenario.options);
		for (const record of second.recording.emitted.filter((item) => item.stream === "connections")) {
			stored.set(record.data.id as string, structuredClone(record.data));
		}
		const current = stored.get("urn:li:fsd_profile:conn-1");
		assert.ok(current, `${scenario.name}: connection record disappeared`);
		if (scenario.shouldEmitEdge) {
			assert.deepEqual(current, {
				connected_at: "2023-11-14T22:13:20.000Z",
				id: "urn:li:fsd_profile:conn-1",
			});
			assert.equal(
				second.recording.protocolMessages.some((message) => message.type === "STATE" && message.stream === "connections"),
				true,
				"a proved inventory with an explicit per-member 404 may advance STATE",
			);
		} else {
			assert.deepEqual(current, prior, `${scenario.name}: partial upsert erased stored fields`);
			assert.equal(
				second.recording.protocolMessages.some((message) => message.type === "STATE" && message.stream === "connections"),
				false,
				`${scenario.name}: transient or malformed row advanced STATE`,
			);
		}
	}
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

	// /me supplies name, headline and picture, but the dash-only fields are
	// unreadable, so the profile row is withheld rather than emitted partial.
	assert.deepEqual(withheldFieldsOf(recording, "profile"), [
		"current_company",
		"current_position_title",
		"industry",
		"location",
		"summary",
	]);
	assert.ok(
		skipResults(recording).some(
			(skip) => diagnosticsOf(skip).source_reason === "linkedin_dash_profile_unavailable",
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

	assert.ok(withheldFieldsOf(recording, "profile").includes("summary"));
	assert.ok(
		skipResults(recording).some(
			(skip) =>
				skip.stream === "profile" &&
				diagnosticsOf(skip).source_reason === "linkedin_profile_fields_unavailable",
		),
	);
});

test("collectLinkedIn: an empty decoration does not block a later usable decoration", async () => {
	const recording = makeRecordingEmit(validateRecord);
	let decorationAttempts = 0;
	const route = (path: string): unknown => {
		if (path === "/voyager/api/relationships/connectionsSummary/") return { entityUrn: "urn:li:fsd_connectionsSummary:12", numConnections: 0 };
		if (path.startsWith("/voyager/api/me")) return ME_RESPONSE;
		if (path.includes("decorationId=")) {
			decorationAttempts += 1;
			return decorationAttempts === 1
				? { elements: [{}] }
				: {
						elements: [
							{
								...DASH_PROFILE_RESPONSE.elements[0],
								firstName: "Decoration",
								lastName: "Two",
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
	assert.equal(profile?.data.full_name, "Decoration Two");
	assert.equal(decorationAttempts, 2);
});

test("collectLinkedIn: a truncated decorated section does not claim complete coverage", async () => {
	for (const elements of [
		[],
		[
			{
				entityUrn: "urn:li:skill:partial",
				name: "Partial first page",
			},
		],
	]) {
		const recording = makeRecordingEmit(validateRecord);
		const truncatedSkills = {
			...DASH_PROFILE_RESPONSE,
			elements: [
				{
					...DASH_PROFILE_RESPONSE.elements[0],
					profileSkills: {
						elements,
						paging: { count: 10, start: 0, total: elements.length + 1 },
					},
				},
			],
		};
		const route = (path: string): unknown => {
			if (path.startsWith("/voyager/api/me")) return ME_RESPONSE;
			if (path.includes("decorationId=")) return truncatedSkills;
			if (path.startsWith("/voyager/api/relationships/dash/connections")) {
				return { elements: [], paging: { total: 0 } };
			}
			return { _error: "http_404" };
		};

		await collectLinkedIn(buildCtx(["skills"], recording, route));

		assert.equal(claimsFullCoverage(recording, "skills"), false);
		assert.equal(recording.emitted.some((row) => row.stream === "skills"), false);
		assert.ok(
			skipResults(recording).some(
				(skip) => skip.stream === "skills" &&
					diagnosticsOf(skip).source_reason === "linkedin_profile_section_unavailable",
			),
		);
	}
});

test("collectLinkedIn: incomplete nested position paging withholds the experience row", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const profile = DASH_PROFILE_RESPONSE.elements[0];
	const sourcePositions = profile?.profilePositionGroups.elements[0]
		?.profilePositionInPositionGroup.elements;
	assert.ok(sourcePositions);
	const incompletePositions = {
		...profile,
		profilePositionGroups: {
			elements: [
				{
					company: { name: "Acme" },
					profilePositionInPositionGroup: {
					elements: sourcePositions,
						paging: { count: 10, start: 0, total: 2 },
					},
				},
			],
			paging: { count: 10, start: 0, total: 1 },
		},
	};
	const route = (path: string): unknown => {
		if (path.startsWith("/voyager/api/me")) return ME_RESPONSE;
		if (path.includes("decorationId=")) return { elements: [incompletePositions] };
		if (path.startsWith("/voyager/api/relationships/dash/connections")) {
			return { elements: [], paging: { total: 0 } };
		}
		return { _error: "http_404" };
	};

	await collectLinkedIn(buildCtx(["experience"], recording, route));

	assert.equal(claimsFullCoverage(recording, "experience"), false);
	assert.equal(recording.emitted.some((row) => row.stream === "experience"), false);
	assert.ok(
		skipResults(recording).some(
			(skip) => skip.stream === "experience" &&
				diagnosticsOf(skip).source_reason === "linkedin_fields_unreadable",
		),
	);
});

test("collectLinkedIn: failed connection paging falls back to zero observed connections", async () => {
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

	assert.equal(recording.emitted.find((row) => row.stream === "profile")?.data.connection_count, 0);
	assert.equal(claimsFullCoverage(recording, "profile"), false);
	assert.ok(
		skipResults(recording).some(
			(skip) =>
				skip.stream === "profile" &&
				!unavailableFieldsOf(skip).includes("connection_count"),
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

	assert.equal(recording.emitted.find((row) => row.stream === "profile")?.data.connection_count, 0);
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
		(skip) => diagnosticsOf(skip).page_reason === "linkedin_connections_page_malformed",
	);
	assert.ok(malformedSkip);
	assert.deepEqual(Object.fromEntries(
		["termination_reason", "observed_count", "total", "missing_urn_count"]
			.map((key) => [key, diagnosticsOf(malformedSkip)[key]]),
	), {
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
					createdAt: 1_700_000_000_000,
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
					ids.map((id) => [id, {
						firstName: `Member ${id.split(":").at(-1)}`,
						headline: null,
						lastName: null,
						publicIdentifier: null,
					}]),
				),
			};
		}
		return { _error: "http_404" };
	};
	await collectLinkedIn(buildCtx(["profile", "connections"], recording, route));

	// Missing dash fields still withhold the row; the count fallback is independent.
	assert.ok(!withheldFieldsOf(recording, "profile").includes("connection_count"));
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

	// Missing dash fields still withhold the row; the count fallback is independent.
	assert.ok(!withheldFieldsOf(recording, "profile").includes("connection_count"));
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

	// Missing dash fields still withhold the row; the count fallback is independent.
	assert.ok(!withheldFieldsOf(recording, "profile").includes("connection_count"));
	assert.equal(
		recording.protocolMessages.some(
			(message) =>
				message.type === "DETAIL_COVERAGE" && message.stream === "connections",
		),
		false,
		"a page whose advertised size differs from the request is not end evidence",
	);
});

async function runConnectionsPageError(pageError: string) {
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
						createdAt: 1_700_000_000_000,
					})),
					}
				: { _error: pageError };
		}
		if (path.startsWith("/voyager/api/identity/dash/profiles?ids=")) {
			const ids = decodeURIComponent(
				path.split("ids=List(")[1]?.split(")")[0] ?? "",
			).split(",");
			return {
				results: Object.fromEntries(
					ids.map((id) => [id, {
						firstName: "Member",
						lastName: null,
						headline: null,
						publicIdentifier: null,
					}]),
				),
			};
		}
		return { _error: "http_404" };
	};
	const error = await collectLinkedIn(buildCtx(["connections"], recording, route))
		.then(() => null, (failure: unknown) => failure);
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
		(skip) => diagnosticsOf(skip).page_reason === "linkedin_connections_page_failed",
	);
	if (/^http_40[13]$/u.test(pageError)) {
		assert.equal(failedSkip, undefined, "a rejected session is not a stream skip");
		return { error, failedSkip };
	}
	assert.ok(failedSkip);
	assert.deepEqual(Object.fromEntries(
		["termination_reason", "observed_count", "total", "missing_urn_count", "error"]
			.map((key) => [key, diagnosticsOf(failedSkip)[key]]),
	), {
		termination_reason: "page_error",
		observed_count: 40,
		total: null,
		missing_urn_count: 0,
		error: pageError,
	});
	return { error, failedSkip };
}

// A failed connections page is a failed read (Collection Profile 5.5): 429 and
// 5xx are reported as stream failures, 401/403 end the run as the session
// failure. Valid rows before the failed page stay upserted either way.
for (const pageError of ["http_503", "http_429"]) {
	test(`collectLinkedIn: a connections page ${pageError} is a failed read, not an unproven enumeration`, async () => {
		const { error, failedSkip } = await runConnectionsPageError(pageError);
		assert.equal(error, null);
		assert.equal(failedSkip?.reason, "stream_collection_failed");
		assert.equal(
			failedSkip?.message,
			"LinkedIn stopped returning connections pages before the list ended; covered entries are upserted only",
		);
		assert.deepEqual(failedSkip?.recovery_hint, {
			action: "retry_by_runtime",
			retryable: true,
		});
	});
}

for (const pageError of ["http_401", "http_403"]) {
	test(`collectLinkedIn: a connections page ${pageError} ends the run as linkedin_session_dead`, async () => {
		const { error } = await runConnectionsPageError(pageError);
		assert.ok(error instanceof Error);
		assert.match(error.message, /^linkedin_session_dead: /u);
	});
}

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
						{ connectedMember: "urn:li:profile:a", createdAt: 1_700_000_000_000 },
						{ connectedMember: "urn:li:profile:b", createdAt: 1_700_000_000_000 },
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
				results: { [urn]: {
					firstName: urn.endsWith(":a") ? "A" : "B",
					lastName: null,
					headline: null,
					publicIdentifier: null,
				} },
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
					diagnosticsOf(skip).source_reason === "linkedin_profile_section_unavailable",
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
				(skip) => skip.stream === stream && diagnosticsOf(skip).source_reason === "linkedin_profile_section_unavailable",
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
		// The row with no readable field is omitted; the row with a readable
		// title or school but an unreadable date is withheld whole.
		assert.ok(withheldFieldsOf(recording, stream).includes("start_date"));
		assert.ok(
			skipResults(recording).some(
				(skip) =>
					skip.stream === stream &&
					diagnosticsOf(skip).source_reason === "linkedin_fields_unreadable" &&
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
		assert.ok(
			withheldFieldsOf(recording, "profile").includes("current_position_title"),
		);
		const experienceCoverage = recording.protocolMessages.find(
			(message): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
				message.type === "DETAIL_COVERAGE" && message.stream === "experience",
		);
		assert.equal(claimsFullCoverage(recording, "experience"), false);
		if (experienceCoverage) assert.equal(experienceCoverage.covered, 0);
		assert.ok(
			skipResults(recording).some(
				(skip) => skip.stream === "profile" && diagnosticsOf(skip).source_reason === "linkedin_profile_fields_unavailable",
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

	assert.ok(
		skipResults(recording).some(
			(skip) => diagnosticsOf(skip).source_reason === "linkedin_profile_fields_unavailable",
		),
	);
	// The group's own experience row is uncovered (malformed title), so both
	// projections from it are unreadable, as is the malformed location.
	assert.deepEqual(withheldFieldsOf(recording, "profile"), [
		"current_company",
		"current_position_title",
		"location",
	]);
});

test("collectLinkedIn: readable empty sections still cannot authorize replacement", async () => {
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
		assert.equal(coverage, undefined);
		assert.equal(claimsFullCoverage(recording, stream), false);
	}
	assert.equal(skipResults(recording).length, 4);
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

test("collectLinkedIn: connection rows without URNs or resolved enrichment are withheld", async () => {
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

	assert.deepEqual(recording.emitted.filter((row) => row.stream === "connections"), []);
	const coverage = recording.protocolMessages.find(
		(
			message,
		): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
			message.type === "DETAIL_COVERAGE" && message.stream === "connections",
	);
	assert.equal(coverage, undefined, "a missing member URN and unresolved profile veto full coverage");
	assert.ok(
		skipResults(recording).some(
			(skip) => diagnosticsOf(skip).page_reason === "linkedin_connections_page_malformed",
		),
	);
	assert.ok(
		progressMessages.some((message) =>
			message.includes("missing_connected_member_urn=1"),
		),
	);
	assert.ok(progressMessages.some((message) => message.includes("enrichment unresolved: 1")));
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
			return { elements: urns.map((connectedMember) => ({ connectedMember, createdAt: 1_700_000_000_000 })) };
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
						publicIdentifier: "blank",
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

	assert.deepEqual(singletonRequests, urns.slice(1));
	const connections = recording.emitted.filter(
		(event) => event.stream === "connections",
	);
	assert.deepEqual(connections.map((event) => event.data), [
		{
			connected_at: "2023-11-14T22:13:20.000Z",
			full_name: "",
			headline: "",
			id: urns[0],
			profile_url: "https://www.linkedin.com/in/blank/",
		},
	]);
	const coverage = recording.protocolMessages.find(
		(message): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
			message.type === "DETAIL_COVERAGE" && message.stream === "connections",
	);
	assert.equal(coverage?.considered, 3);
	assert.equal(coverage?.covered, 1, "malformed and incomplete enrichment withholds both partial rows");
	assert.ok(
		progressMessages.some((message) =>
			message.includes("malformed_enrichment=1"),
		),
	);
});

test("collectLinkedIn: batch array enrichment with missing fields withholds partial rows", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const urn = "urn:li:profile:last-name-only";
	const route = (path: string): unknown => {
		if (path.startsWith("/voyager/api/me")) return ME_RESPONSE;
		if (path.startsWith("/voyager/api/relationships/dash/connections")) {
			return { elements: [{ connectedMember: urn, createdAt: 1_700_000_000_000 }] };
		}
		if (path.startsWith("/voyager/api/identity/dash/profiles?ids=")) {
			return { elements: [{ entityUrn: urn, lastName: "Only" }] };
		}
		return { _error: "http_404" };
	};
	await collectLinkedIn(buildCtx(["connections"], recording, route));

	assert.deepEqual(recording.emitted.filter((event) => event.stream === "connections"), []);
	assert.deepEqual(withheldFieldsOf(recording, "connections"), ["headline", "profile_url"]);
	const coverage = recording.protocolMessages.find(
		(message): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
			message.type === "DETAIL_COVERAGE" && message.stream === "connections",
	);
	assert.equal(coverage?.considered, 1);
	assert.equal(coverage?.covered, 0);
	assert.equal(claimsFullCoverage(recording, "connections"), false);
});

test("collectLinkedIn: singleton enrichment preserves source-backed blanks in map and array forms", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const urns = ["urn:li:profile:blank-map", "urn:li:profile:blank-array"];
	const singletonRequests: string[] = [];
	const route = (path: string): unknown => {
		if (path.startsWith("/voyager/api/me")) return ME_RESPONSE;
		if (path.startsWith("/voyager/api/relationships/dash/connections")) {
			return { elements: urns.map((connectedMember) => ({ connectedMember, createdAt: 1_700_000_000_000 })) };
		}
		if (path.startsWith("/voyager/api/identity/dash/profiles?ids=")) {
			const ids = decodeURIComponent(
				path.split("ids=List(")[1]?.split(")")[0] ?? "",
			).split(",");
			if (ids.length > 1) return { _error: "http_503" };
			singletonRequests.push(ids[0] ?? "");
			if (ids[0] === urns[0]) {
				return { results: { [urns[0] as string]: { firstName: "", lastName: null, headline: "", publicIdentifier: null } } };
			}
			return { elements: [{ entityUrn: urns[1], lastName: "", firstName: null, headline: "", publicIdentifier: null }] };
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

const ALL_STREAMS = [
	"profile", "experience", "education", "skills", "languages", "connections",
];

function assertUpsertOnly(
	recording: ReturnType<typeof makeRecordingEmit>,
	expectedCounts: Record<string, number>,
): void {
	assert.equal(recording.skipped.length, 0);
	assert.equal(
		recording.protocolMessages.some((message) => message.type === "STATE"),
		false,
	);
	assert.equal(JSON.stringify(recording.events).includes('"op":"delete"'), false);
	assert.equal(skipResults(recording).length, ALL_STREAMS.length);
	for (const stream of ALL_STREAMS) {
		assert.equal(claimsFullCoverage(recording, stream), false, stream);
		const gaps = skipResults(recording).filter((gap) => gap.stream === stream);
		assert.equal(gaps.length, 1, stream);
		assert.equal(gaps[0]?.reason, "linkedin_enumeration_unproven", stream);
		assert.deepEqual(gaps[0]?.recovery_hint, {
			action: "retry_by_runtime", retryable: true,
		});
		assert.equal(
			recording.emitted.filter((row) => row.stream === stream).length,
			expectedCounts[stream] ?? 0,
			stream,
		);
	}
}

test("collectLinkedIn: every stream remains UPSERT-ONLY across enumeration counterexamples", async (t) => {
	const sectionKeys = [
		"profilePositionGroups", "profileEducations", "profileSkills", "profileLanguages",
	] as const;
	const fullCounts = Object.fromEntries(ALL_STREAMS.map((stream) => [stream, 1]));
	const skill = { entityUrn: "urn:li:skill:1", name: "A" };
	const next = [{ rel: "next", href: "/voyager/api/identity/dash/profiles?start=1" }];
	for (const fixture of [
		"full", "empty", "truncated", "nested-empty", "nested-one", "next-empty", "next-one",
	]) {
		await t.test(fixture, async () => {
			const profile: Record<string, unknown> = structuredClone(DASH_PROFILE_RESPONSE.elements[0] ?? {});
			let connections: unknown = CONNECTIONS_PAGE_1;
			let expectedCounts = { ...fullCounts };
			if (fixture === "empty") {
				for (const key of sectionKeys) {
					profile[key] = { elements: [], paging: { start: 0, count: 1, total: 0 } };
				}
				connections = { elements: [], paging: { start: 0, count: 40, total: 0 } };
				expectedCounts = { profile: 1 };
			} else if (fixture === "truncated") {
				for (const key of sectionKeys) {
					const section = profile[key] as { elements: unknown[] };
					profile[key] = { ...section, paging: { start: 0, count: 1, total: 2 } };
				}
				connections = { ...CONNECTIONS_PAGE_1, paging: { start: 0, count: 40, total: 2 } };
				expectedCounts = { connections: 1 };
			} else if (fixture.startsWith("nested-")) {
				const one = fixture === "nested-one";
				profile.profileSkills = {
					elements: [{
						elements: one ? [skill] : [],
						paging: { start: 0, count: 1, total: one ? 2 : 1 },
					}],
					paging: { start: 0, count: 1, total: 1 },
				};
				expectedCounts.skills = one ? 1 : 0;
			} else if (fixture.startsWith("next-")) {
				const one = fixture === "next-one";
				profile.profileSkills = {
					elements: one ? [skill] : [],
					paging: { start: 0, count: 1, total: one ? 1 : 0, links: next },
				};
				connections = {
					elements: one ? CONNECTIONS_PAGE_1.elements : [],
					paging: { start: 0, count: 40, total: one ? 1 : 0, links: next },
				};
				expectedCounts.skills = one ? 1 : 0;
				expectedCounts.connections = one ? 1 : 0;
				// Profile count remains readable independently of continuation.
			}
			const recording = makeRecordingEmit(validateRecord);
			const ctx = buildCtx(ALL_STREAMS, recording);
			// Bypass the legacy fixture helper: preserve the exact nested and
			// continuation payloads, including contradictory provider totals.
			ctx.page = makeFakePage((path) => {
				if (path.startsWith("/voyager/api/identity/dash/profiles?q=memberIdentity")) {
					return { elements: [profile] };
				}
				if (path.startsWith("/voyager/api/relationships/dash/connections")) {
					return connections;
				}
				return routeVoyagerPath(path);
			});
			await collectLinkedIn({
				...ctx,
				emitRecord: async (...args) => {
					for (const arg of args) {
						if (typeof arg === "object" && arg !== null && "op" in arg) {
							assert.notEqual(arg.op, "delete");
						}
					}
					return ctx.emitRecord(...args);
				},
			});
			// Profile remains an upsert when identity proof is absent.
			assertUpsertOnly(recording, expectedCounts);
			if (fixture === "next-empty" || fixture === "next-one") {
				assert.equal(recording.emitted.find((row) => row.stream === "profile")?.data.connection_count, 1);
			}
			if (fixture === "nested-one" || fixture === "next-one") {
				assert.equal(recording.emitted.find((row) => row.stream === "skills")?.data.id, skill.entityUrn);
			}
		});
	}
});

// Provider-backed evidence fixtures are synthetic and keep exact response shapes.
const PROOF_ME = {
	...ME_RESPONSE, plainId: 12,
	miniProfile: { ...ME_RESPONSE.miniProfile,
		entityUrn: "urn:li:fs_miniProfile:12",
		dashEntityUrn: "urn:li:fsd_profile:12",
		objectUrn: "urn:li:member:12",
	},
};
function proofProfile(): Record<string, any> {
	const profile: Record<string, any> = structuredClone(DASH_PROFILE_RESPONSE.elements[0]) as Record<string, any>;
	profile.entityUrn = "urn:li:fsd_profile:12";
	profile.publicIdentifier = "anon-member";
	profile.profileEducations.elements[0].entityUrn = "urn:li:education:1";
	profile.profilePositionGroups.elements[0].entityUrn = "urn:li:positionGroup:1";
	profile.profilePositionGroups.elements[0].profilePositionInPositionGroup.elements[0].entityUrn = "urn:li:position:1";
	return profile;
}
const PROOF_SUMMARY = { entityUrn: "urn:li:fsd_connectionsSummary:12", numConnections: 1 };
async function collectProof(options: {
	profile?: Record<string, any>;
	before?: unknown; after?: unknown; confirmation?: unknown;
	connections?: unknown; resolution?: unknown; me?: unknown;
} = {}) {
	const recording = makeRecordingEmit(validateRecord);
	const paths: string[] = [];
	const progressMessages: string[] = [];
	let summaryReads = 0;
	let walkEnded = false;
	const ctx = buildCtx(ALL_STREAMS, recording);
	ctx.progress = async (message) => { progressMessages.push(message); };
	ctx.page = makeFakePage((path) => {
		paths.push(path);
		if (path === "/voyager/api/me") return options.me ?? PROOF_ME;
		if (path === "/voyager/api/relationships/connectionsSummary/") {
			return ++summaryReads === 1 ? options.before ?? PROOF_SUMMARY : options.after ?? PROOF_SUMMARY;
		}
		if (path.startsWith("/voyager/api/identity/dash/profiles?q=memberIdentity")) {
			return { elements: [options.profile ?? proofProfile()] };
		}
		if (path.startsWith("/voyager/api/identity/dash/profiles?ids=")) return options.resolution ?? RESOLVED_PROFILES;
		if (path.startsWith("/voyager/api/relationships/dash/connections")) {
			const start = Number(new URL(path, "https://www.linkedin.com").searchParams.get("start"));
			if (walkEnded) return options.confirmation ?? { elements: [], paging: { start, total: start } };
			const result = start === 0 ? options.connections ?? { elements: CONNECTIONS_PAGE_1.elements } : { elements: [] };
			if (Array.isArray((result as { elements?: unknown[] }).elements) && (result as { elements: unknown[] }).elements.length === 0) walkEnded = true;
			return result;
		}
		return { _error: "http_404" };
	});
	await collectLinkedIn(ctx);
	return { recording, paths, summaryReads, progressMessages };
}

test("provider evidence: complete inventories emit RECORD, coverage, then STATE", async () => {
	const { recording, paths, summaryReads } = await collectProof();
	assert.equal(summaryReads, 2);
	assert.equal(skipResults(recording).length, 0);
	assert.equal(paths.filter((path) => path.includes("connectionsSummary")).length, 2);
	assert.ok(paths.some((path) => path.endsWith("&start=1")));
	for (const stream of ALL_STREAMS) {
		assert.equal(claimsFullCoverage(recording, stream), true, stream);
		const stateIndex = recording.events.findIndex((event) => event.kind === "message" && event.message.type === "STATE" && event.message.stream === stream);
		const coverageIndex = recording.events.findIndex((event) => event.kind === "message" && event.message.type === "DETAIL_COVERAGE" && event.message.stream === stream);
		const rowIndex = recording.events.findIndex((event) => event.kind === "record" && event.stream === stream);
		assert.ok(rowIndex >= 0 && rowIndex < coverageIndex && coverageIndex < stateIndex, stream);
	}
});

test("provider evidence: proved zero totals cover empty sections and connections", async () => {
	const profile = proofProfile();
	for (const key of ["profilePositionGroups", "profileEducations", "profileSkills", "profileLanguages"]) {
		profile[key] = { elements: [], paging: { start: 0, total: 0 } };
	}
	const zero = { ...PROOF_SUMMARY, numConnections: 0 };
	const { recording, paths } = await collectProof({ profile, before: zero, after: zero,
		connections: { elements: [], paging: { start: 0, total: 0 } } });
	assert.equal(skipResults(recording).length, 0);
	assert.equal(paths.filter((path) => path.endsWith("&start=0")).length, 2);
	for (const stream of ALL_STREAMS) assert.equal(claimsFullCoverage(recording, stream), true, stream);
});

for (const [name, options, reason] of [
	["missing summary", { before: { _error: "http_404" } }, "summary_request_failed"],
	["changed summary", { after: { ...PROOF_SUMMARY, numConnections: 2 } }, "summary_total_changed"],
	["wrong summary owner", { before: { ...PROOF_SUMMARY, entityUrn: "urn:li:fsd_connectionsSummary:123" } }, "summary_owner_mismatch"],
	["malformed summary total", { before: { ...PROOF_SUMMARY, numConnections: "1" } }, "summary_total_invalid"],
	["missing confirmation", { confirmation: { _error: "http_503" } }, "connection_confirmation_missing"],
	["nonempty confirmation", { confirmation: { elements: CONNECTIONS_PAGE_1.elements } }, "connection_confirmation_missing"],
	["contradictory confirmation", { confirmation: { elements: [], paging: { start: 0 } } }, "connection_confirmation_malformed"],
	["confirmation continuation", { confirmation: { elements: [], paging: { links: [{}] } } }, "connection_confirmation_malformed"],
	["summary exceeds distinct rows", { before: { ...PROOF_SUMMARY, numConnections: 2 }, after: { ...PROOF_SUMMARY, numConnections: 2 } }, "connection_total_mismatch"],
	["per-member 404 omits optional enrichment", { resolution: { errors: { "urn:li:fsd_profile:conn-1": { status: 404 } } } }, ""],
	["endpoint HTTP 404 is not a per-member 404", { resolution: { _error: "http_404" } }, "linkedin_connection_enrichment_incomplete"],
] as const) {
	test(`provider evidence: ${name}`, async () => {
		const { recording } = await collectProof(options);
		if (name === "per-member 404 omits optional enrichment") {
			assert.equal(claimsFullCoverage(recording, "connections"), true);
			assert.equal(recording.protocolMessages.some((message) => message.type === "STATE" && message.stream === "connections"), true);
			assert.deepEqual(
				recording.emitted.filter((row) => row.stream === "connections").map((row) => row.data),
				[{ connected_at: "2023-11-14T22:13:20.000Z", id: "urn:li:fsd_profile:conn-1" }],
			);
		} else {
			assert.equal(claimsFullCoverage(recording, "connections"), false);
			assert.equal(recording.protocolMessages.some((message) => message.type === "STATE" && message.stream === "connections"), false);
			const gap = skipResults(recording).find((message) => message.stream === "connections");
			assert.equal(diagnosticsOf(gap ?? {}).evidence_reason, reason);
		}
	});
}

for (const [stream, key] of [["education", "profileEducations"], ["skills", "profileSkills"], ["languages", "profileLanguages"], ["experience", "profilePositionGroups"]] as const) {
	for (const defect of ["total", "duplicate", "missing-urn", "continuation"]) {
		test(`provider evidence: ${stream} ${defect} vetoes inventory proof`, async () => {
			const profile = proofProfile();
			const collection = profile[key];
			if (defect === "total") collection.paging.total += 1;
			if (defect === "duplicate") { collection.elements.push(collection.elements[0]); collection.paging.total = 2; }
			if (defect === "missing-urn") delete collection.elements[0].entityUrn;
			if (defect === "continuation") collection.paging.links = [{ rel: "next" }];
			const { recording } = await collectProof({ profile });
			assert.equal(claimsFullCoverage(recording, stream), false);
			assert.equal(recording.protocolMessages.some((message) => message.type === "STATE" && message.stream === stream), false);
		});
	}
}
test("provider evidence: nested experience count and owner identity independently veto proof", async () => {
	const profile = proofProfile();
	profile.profilePositionGroups.elements[0].profilePositionInPositionGroup.paging.total = 2;
	const first = await collectProof({ profile });
	assert.equal(claimsFullCoverage(first.recording, "experience"), false);
	profile.entityUrn = "urn:li:fsd_profile:123";
	const second = await collectProof({ profile });
	for (const stream of ALL_STREAMS.filter((stream) => stream !== "connections")) {
		assert.equal(claimsFullCoverage(second.recording, stream), false);
	}
});


test("profile count uses owner summary while withheld connection enrichment remains unproven", async () => {
	const total = { ...PROOF_SUMMARY, numConnections: 354 };
	const { recording } = await collectProof({
		before: total, after: total, resolution: { _error: "http_404" },
	});
	assert.equal(recording.emitted.find((row) => row.stream === "profile")?.data.connection_count, 354);
	assert.equal(claimsFullCoverage(recording, "profile"), true);
	assert.equal(recording.protocolMessages.some((message) => message.type === "STATE" && message.stream === "profile"), true);
	assert.equal(claimsFullCoverage(recording, "connections"), false);
	assert.equal(recording.protocolMessages.some((message) => message.type === "STATE" && message.stream === "connections"), false);
});

for (const [summary, reason] of [
	[{ entityUrn: PROOF_SUMMARY.entityUrn }, "summary_total_invalid"],
	[{ ...PROOF_SUMMARY, entityUrn: "urn:li:fsd_connectionsSummary:99" }, "summary_owner_mismatch"],
	[{ _error: "http_503" }, "summary_request_failed"],
] as const) {
	test(`profile count walked distinct fallback preserves profile for ${reason}`, async () => {
		const { recording, progressMessages } = await collectProof({ before: summary, after: summary });
		const profile = recording.emitted.find((row) => row.stream === "profile")?.data;
		assert.ok(profile);
		assert.equal(profile.connection_count, 1);
		assert.equal(profile.full_name, "Anon Member");
		assert.equal(claimsFullCoverage(recording, "profile"), true);
		assert.equal(recording.protocolMessages.some((message) => message.type === "STATE" && message.stream === "profile"), true);
		assert.equal(claimsFullCoverage(recording, "connections"), false);
		assert.equal(recording.protocolMessages.some((message) => message.type === "STATE" && message.stream === "connections"), false);
		assert.ok(progressMessages.includes(`LinkedIn profile connection_count=1 (walked distinct fallback): ${reason}`));
	});
}

test("summary 40 cannot stop an 80-member source walk", async () => {
	const recording = makeRecordingEmit(validateRecord);
	const ctx = buildCtx(["connections"], recording);
	const starts: number[] = [];
	const members = Array.from({ length: 80 }, (_, i) => ({
		connectedMember: `urn:li:fsd_profile:member-${i}`, createdAt: 1_700_000_000_000,
	}));
	ctx.page = makeFakePage((path) => {
		if (path === "/voyager/api/relationships/connectionsSummary/") return { ...PROOF_SUMMARY, numConnections: 40 };
		if (path.startsWith("/voyager/api/relationships/dash/connections")) {
			const start = Number(new URL(path, "https://www.linkedin.com").searchParams.get("start"));
			starts.push(start);
			return { elements: members.slice(start, start + 40) };
		}
		if (path.startsWith("/voyager/api/identity/dash/profiles?ids=")) {
			return { results: Object.fromEntries(members.map(({ connectedMember }) => [connectedMember, {
				firstName: "Member", lastName: null, headline: null, publicIdentifier: null,
			}])) };
		}
		return routeVoyagerPath(path);
	});
	await collectLinkedIn(ctx);
	assert.deepEqual(starts.slice(0, 3), [0, 40, 80]);
	assert.equal(recording.emitted.length, 80);
	assert.equal(new Set(recording.emitted.map((row) => row.data.id)).size, 80);
	assert.equal(claimsFullCoverage(recording, "connections"), false);
	assert.equal(recording.protocolMessages.some((message) => message.type === "STATE"), false);
	const gap = skipResults(recording).find((message) => message.stream === "connections");
	assert.equal(diagnosticsOf(gap ?? {}).evidence_reason, "connection_total_mismatch");
	assert.equal(diagnosticsOf(gap ?? {}).observed_count, 80);
	assert.equal(diagnosticsOf(gap ?? {}).withheld_count, 0);
});

for (const duplicate of [true, false]) {
	test(`flattened experience IDs across distinct groups: duplicate=${duplicate}`, async () => {
		const profile = proofProfile();
		const groups = profile.profilePositionGroups;
		const second = structuredClone(groups.elements[0]);
		second.entityUrn = "urn:li:positionGroup:2";
		const position = second.profilePositionInPositionGroup.elements[0];
		position.title = "Different title";
		if (!duplicate) position.entityUrn = "urn:li:position:2";
		groups.elements.push(second);
		groups.paging.total = 2;
		groups.paging.count = 2;
		const { recording } = await collectProof({ profile });
		const rows = recording.emitted.filter((row) => row.stream === "experience");
		assert.equal(rows.length, duplicate ? 1 : 2);
		assert.equal(new Set(rows.map((row) => row.data.id)).size, rows.length);
		assert.equal(claimsFullCoverage(recording, "experience"), !duplicate);
		assert.equal(recording.protocolMessages.some((message) => message.type === "STATE" && message.stream === "experience"), !duplicate);
		if (duplicate) {
			assert.equal(rows[0]?.data.title, "Staff Engineer");
			const gap = skipResults(recording).find((message) => message.stream === "experience");
			assert.equal(diagnosticsOf(gap ?? {}).evidence_reason, "experience_flattened_id_duplicate");
			assert.deepEqual(diagnosticsOf(gap ?? {}).omitted_rows, { duplicate_experience_id: 1 });
		}
	});
}

test("profile fallback counts distinct walked members before failed enrichment", async () => {
	const member = CONNECTIONS_PAGE_1.elements[0];
	const { recording, progressMessages } = await collectProof({
		before: { _error: "http_503" }, after: { _error: "http_503" },
		connections: { elements: [member, member] }, resolution: { _error: "http_404" },
	});
	assert.equal(recording.emitted.find((row) => row.stream === "profile")?.data.connection_count, 1);
	assert.equal(recording.emitted.filter((row) => row.stream === "connections").length, 0);
	assert.ok(progressMessages.includes("LinkedIn profile connection_count=1 (walked distinct fallback): summary_request_failed"));
});

// Synthetic opaque owner IDs mirror the source shape without personal data.
const OPAQUE_OWNER_CONNECTIONS = JSON.parse(readFileSync(
	new URL("./fixtures/scrubbed/opaque-owner-connections.json", import.meta.url), "utf8",
)) as {
	me: unknown;
	summary: { entityUrn: string; numConnections: number };
	listing: unknown;
	terminal: unknown;
	profiles: unknown;
};

for (const scenario of [
	{ name: "matching source total", total: 2, complete: true },
	{ name: "mismatched source total", total: 3, complete: false },
	{ name: "missing source total", total: null, complete: false },
]) {
	test(`collectLinkedIn: opaque owner with ${scenario.name}`, async () => {
		const fixture = OPAQUE_OWNER_CONNECTIONS;
		const recording = makeRecordingEmit(validateRecord);
		const route = (path: string): unknown => {
			if (path.startsWith("/voyager/api/me")) return fixture.me;
			if (path === "/voyager/api/relationships/connectionsSummary/") {
				return scenario.total === null
					? { entityUrn: fixture.summary.entityUrn }
					: { ...fixture.summary, numConnections: scenario.total };
			}
			if (path.startsWith("/voyager/api/relationships/dash/connections")) {
				return path.endsWith("&start=0") ? fixture.listing : fixture.terminal;
			}
			if (path.startsWith("/voyager/api/identity/dash/profiles?ids=")) return fixture.profiles;
			return { _error: "http_404" };
		};
		await collectLinkedIn(buildCtx(["connections"], recording, route));
		assert.equal(recording.emitted.filter((row) => row.stream === "connections").length, 2);
		assert.equal(claimsFullCoverage(recording, "connections"), scenario.complete);
		assert.equal(skipResults(recording).some((skip) => skip.stream === "connections" &&
			skip.reason === "linkedin_enumeration_unproven"), !scenario.complete);
	});
}
