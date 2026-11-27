// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { setConnectorDiagnosticSink } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import type {
	EmittedMessage,
	RecordData,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	AUTH_FAILED,
	classifyResponse,
	collectMountainProject,
	HOME_URL,
	hasMountainProjectSession,
	type MountainProjectCollectContext,
	type MpResponse,
	probeMountainProjectSession,
} from "./index.ts";

const ORIGIN = "https://www.mountainproject.com";
const USER_ID = "999000000001";
const PROFILE_PATH = `/user/${USER_ID}/alex-example`;
const fixture = (name: string) =>
	readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
const PROFILE_HTML = fixture("profile.html");
const TICK_CSV = fixture("tick-export.csv");
const TODO_CSV = fixture("todo-export.csv");
const CANARY_TICK_CSV = fixture("canary-tick-export.csv");
const CANARY_TODO_CSV = fixture("canary-todo-export.csv");
const SIGNED_OUT_HTML =
	"<html><script>w.ap.config = {'isLoggedIn': 0,\n'userId': undefined,\n};</script></html>";

setConnectorDiagnosticSink(() => {});

type Route = (path: string) => MpResponse;

const html = (body: string, url: string, status = 200): MpResponse => ({
	kind: "response",
	status,
	url,
	contentType: "text/html; charset=UTF-8",
	body,
});
const csv = (body: string, url: string): MpResponse => ({
	kind: "response",
	status: 200,
	url,
	contentType: "text/csv; charset=UTF-8",
	body,
});

/** The site as the signed-in owner sees it. */
const signedInSite: Route = (path) => {
	if (path === `/user/${USER_ID}`) {
		return html(PROFILE_HTML, `${ORIGIN}${PROFILE_PATH}`);
	}
	if (path.includes("/tick-export")) return csv(TICK_CSV, `${ORIGIN}${path}`);
	if (path.includes("/todo-export")) return csv(TODO_CSV, `${ORIGIN}${path}`);
	return html("not found", `${ORIGIN}${path}`, 404);
};

interface FakePage {
	evaluate: (
		fn: unknown,
		args: { op: string; path?: string },
	) => Promise<unknown>;
	goto: (url: string) => Promise<null>;
	url: () => string;
	gotos: string[];
	fetched: string[];
}

function fakePage(options: {
	origin?: string;
	config?: unknown;
	route?: Route;
}): FakePage {
	let origin = options.origin ?? ORIGIN;
	const route = options.route ?? signedInSite;
	const page: FakePage = {
		gotos: [],
		fetched: [],
		url: () => `${origin}/`,
		goto: async (url: string) => {
			page.gotos.push(url);
			origin = new URL(url).origin;
			return null;
		},
		evaluate: async (_fn, args) => {
			if (args.op === "origin") return origin;
			if (args.op === "session") {
				return {
					origin,
					config:
						origin === ORIGIN
							? (options.config ?? { isLoggedIn: 1, userId: Number(USER_ID) })
							: null,
				};
			}
			if (args.op === "fetch" && typeof args.path === "string") {
				page.fetched.push(args.path);
				if (origin !== ORIGIN) return { kind: "wrong_origin", origin };
				return route(args.path);
			}
			throw new Error(`unexpected evaluate ${JSON.stringify(args)}`);
		},
	};
	return page;
}

interface Harness {
	ctx: MountainProjectCollectContext;
	messages: EmittedMessage[];
	records: Array<{ stream: string; data: RecordData }>;
	failures: Array<{
		stream: string;
		message: string;
		retryable: boolean | undefined;
	}>;
}

function harness(
	page: FakePage,
	streams: string[],
	state: Record<string, unknown> = {},
): Harness {
	const messages: EmittedMessage[] = [];
	const records: Harness["records"] = [];
	const failures: Harness["failures"] = [];
	const requested = new Map<string, StreamScope>(
		streams.map((name) => [name, { name } as StreamScope]),
	);
	return {
		messages,
		records,
		failures,
		ctx: {
			page: page as unknown as MountainProjectCollectContext["page"],
			requested,
			state,
			emit: async (msg) => {
				messages.push(msg);
			},
			emitRecord: async (stream, data) => {
				records.push({ stream, data });
			},
			reportStreamFailure: async (stream, message, options) => {
				failures.push({ stream, message, retryable: options?.retryable });
			},
		},
	};
}

const ALL = ["profile", "ticks", "saved_routes"];
const of = (h: Harness, stream: string) =>
	h.records.filter((r) => r.stream === stream);
const typed = (h: Harness, type: string, stream: string) =>
	h.messages.filter(
		(m) => m.type === type && (m as { stream?: string }).stream === stream,
	);
/** The STATE cursors a run wrote, keyed by stream, as the runtime hands them back. */
const stateAfter = (h: Harness): Record<string, unknown> =>
	Object.fromEntries(
		h.messages
			.filter((m) => m.type === "STATE")
			.map((m) => [
				(m as { stream: string }).stream,
				(m as { cursor: unknown }).cursor,
			]),
	);
const fingerprintIds = (state: Record<string, unknown>, stream: string) =>
	Object.keys(
		(state[stream] as { fingerprints: Record<string, string> }).fingerprints,
	).sort();

test("a signed-in run reads the profile and both exports and proves each list whole", async () => {
	const page = fakePage({});
	const h = harness(page, ALL);
	await collectMountainProject(h.ctx, { requestDelayMs: 0 });

	assert.deepEqual(page.fetched, [
		`/user/${USER_ID}`,
		`${PROFILE_PATH}/tick-export`,
		`${PROFILE_PATH}/todo-export`,
	]);
	assert.equal(of(h, "profile").length, 1);
	assert.equal(of(h, "profile")[0]?.data.display_name, "Alex Example");
	assert.equal(of(h, "ticks").length, 7);
	assert.equal(of(h, "saved_routes").length, 2);
	assert.deepEqual(h.failures, []);
	for (const [stream, count] of [
		["ticks", 7],
		["saved_routes", 2],
		["profile", 1],
	] as const) {
		const coverage = typed(h, "DETAIL_COVERAGE", stream);
		assert.equal(coverage.length, 1, `${stream} coverage`);
		assert.equal((coverage[0] as { considered?: number }).considered, count);
	}
	assert.equal(typed(h, "STATE", "ticks").length, 1);
	assert.equal(typed(h, "STATE", "saved_routes").length, 1);
	assert.equal(typed(h, "STATE", "profile").length, 1);
	assert.equal(typed(h, "SKIP_RESULT", "ticks").length, 0);
	const state = stateAfter(h);
	assert.equal(fingerprintIds(state, "ticks").length, 7);
	assert.deepEqual(fingerprintIds(state, "saved_routes"), [
		"105700101",
		"105700102",
	]);
	assert.deepEqual(fingerprintIds(state, "profile"), [USER_ID]);
});

test("the test account's real exports and profile counts make a whole run of 5 ticks and 3 saved routes", async () => {
	// The synthetic profile page with the test account's own counts in it.
	const profile = PROFILE_HTML.replace("View All 7", "View All 5").replace(
		"Sort &amp; Filter All 2",
		"Sort &amp; Filter All 3",
	);
	const page = fakePage({
		route: (path) => {
			if (path === `/user/${USER_ID}`) {
				return html(profile, `${ORIGIN}${PROFILE_PATH}`);
			}
			if (path.includes("/tick-export")) {
				return csv(CANARY_TICK_CSV, `${ORIGIN}${path}`);
			}
			return csv(CANARY_TODO_CSV, `${ORIGIN}${path}`);
		},
	});
	const h = harness(page, ALL);
	await collectMountainProject(h.ctx, { requestDelayMs: 0 });
	assert.deepEqual(h.failures, []);
	assert.equal(of(h, "ticks").length, 5);
	assert.equal(of(h, "saved_routes").length, 3);
	assert.equal(
		of(h, "ticks").find((r) => r.data.id === "105872293:2026-11-11:2")?.data
			.notes,
		"Canary tick, linked pitches 2 and 3\nGear: single rack to 3in",
	);
	assert.equal(typed(h, "SKIP_RESULT", "ticks").length, 0);
	assert.equal(typed(h, "SKIP_RESULT", "saved_routes").length, 0);
	assert.equal(typed(h, "DETAIL_COVERAGE", "ticks").length, 1);
	assert.equal(typed(h, "DETAIL_COVERAGE", "saved_routes").length, 1);
});

test("a second run over an unchanged account re-emits nothing but still proves each list whole", async () => {
	const first = harness(fakePage({}), ALL);
	await collectMountainProject(first.ctx, { requestDelayMs: 0 });
	const second = harness(fakePage({}), ALL, stateAfter(first));
	await collectMountainProject(second.ctx, { requestDelayMs: 0 });

	assert.deepEqual(second.records, []);
	for (const stream of ALL) {
		assert.equal(typed(second, "DETAIL_COVERAGE", stream).length, 1, stream);
		assert.equal(typed(second, "STATE", stream).length, 1, stream);
	}
	assert.equal(
		(typed(second, "DETAIL_COVERAGE", "ticks")[0] as { considered?: number })
			.considered,
		7,
	);
	// The carried-forward cursor still names every record.
	assert.deepEqual(
		fingerprintIds(stateAfter(second), "ticks"),
		fingerprintIds(stateAfter(first), "ticks"),
	);
});

test("a second run emits only the changed record and drops a removed one from the cursor", async () => {
	const first = harness(fakePage({}), ["ticks", "saved_routes"]);
	await collectMountainProject(first.ctx, { requestDelayMs: 0 });
	const prior = stateAfter(first);

	// One note edited; the last to-do route removed (and the profile count with it).
	const editedTicks = TICK_CSV.replace(
		"Warm-up lap.",
		"Warm-up lap, felt stiff.",
	);
	const todoLines = TODO_CSV.trimEnd().split("\n");
	const shorterTodos = `${todoLines.slice(0, -1).join("\n")}\n`;
	const page = fakePage({
		route: (path) => {
			if (path === `/user/${USER_ID}`) {
				return html(
					PROFILE_HTML.replace(
						"Sort &amp; Filter All 2",
						"Sort &amp; Filter All 1",
					),
					`${ORIGIN}${PROFILE_PATH}`,
				);
			}
			if (path.includes("/tick-export")) {
				return csv(editedTicks, `${ORIGIN}${path}`);
			}
			return csv(shorterTodos, `${ORIGIN}${path}`);
		},
	});
	const second = harness(page, ["ticks", "saved_routes"], prior);
	await collectMountainProject(second.ctx, { requestDelayMs: 0 });

	assert.deepEqual(
		second.records.map((r) => [r.stream, r.data.id]),
		[["ticks", "105700001:2026-10-04:2"]],
	);
	assert.equal(second.records[0]?.data.notes, "Warm-up lap, felt stiff.");
	const after = stateAfter(second);
	assert.deepEqual(fingerprintIds(after, "saved_routes"), ["105700101"]);
	assert.equal(fingerprintIds(after, "ticks").length, 7);
});

test("a record outside the selected range is not fingerprinted, so widening the range later emits it", async () => {
	const first = harness(fakePage({}), ["ticks"]);
	first.ctx.isRecordSelected = (_stream, data) =>
		String(data.date) >= "2026-01-01";
	await collectMountainProject(first.ctx, { requestDelayMs: 0 });
	assert.equal(
		fingerprintIds(stateAfter(first), "ticks").includes(
			"105700005:2025-07-01:1",
		),
		false,
	);

	const second = harness(fakePage({}), ["ticks"], stateAfter(first));
	await collectMountainProject(second.ctx, { requestDelayMs: 0 });
	assert.deepEqual(
		second.records.map((r) => r.data.id),
		["105700005:2025-07-01:1"],
	);
});

test("a list not proven whole emits its records but writes no cursor, so nothing is pruned", async () => {
	const first = harness(fakePage({}), ["saved_routes"]);
	await collectMountainProject(first.ctx, { requestDelayMs: 0 });
	const page = fakePage({
		route: (path) =>
			path.includes("/todo-export")
				? csv(`${TODO_CSV.split("\n")[0]}\n`, `${ORIGIN}${path}`)
				: signedInSite(path),
	});
	// The export is empty while the profile still counts 2: short, not whole.
	const second = harness(page, ["saved_routes"], stateAfter(first));
	await collectMountainProject(second.ctx, { requestDelayMs: 0 });
	assert.equal(typed(second, "STATE", "saved_routes").length, 0);
	assert.equal(
		(typed(second, "SKIP_RESULT", "saved_routes")[0] as { reason?: string })
			.reason,
		"export_shorter_than_profile_count",
	);
});

test("only the requested exports are fetched; the profile is read but not emitted", async () => {
	const page = fakePage({});
	const h = harness(page, ["saved_routes"]);
	await collectMountainProject(h.ctx, { requestDelayMs: 0 });
	assert.equal(
		page.fetched.some((path) => path.includes("/tick-export")),
		false,
	);
	assert.equal(of(h, "profile").length, 0);
	assert.equal(of(h, "saved_routes").length, 2);
});

test("nothing requested makes no request", async () => {
	const page = fakePage({});
	const h = harness(page, []);
	await collectMountainProject(h.ctx, { requestDelayMs: 0 });
	assert.deepEqual(page.fetched, []);
	assert.deepEqual(page.gotos, []);
});

test("a run that starts off the site lands on mountainproject.com first", async () => {
	const page = fakePage({ origin: "https://www.onxmaps.com" });
	const h = harness(page, ["ticks"]);
	await collectMountainProject(h.ctx, { requestDelayMs: 0 });
	assert.deepEqual(page.gotos, [HOME_URL]);
	assert.equal(of(h, "ticks").length, 7);
});

test("a signed-out page stops the run with the auth code", async () => {
	const page = fakePage({ config: { isLoggedIn: 0 } });
	const h = harness(page, ALL);
	await assert.rejects(
		collectMountainProject(h.ctx, { requestDelayMs: 0 }),
		(error: unknown) => {
			assert.equal((error as { code?: string }).code, AUTH_FAILED);
			return true;
		},
	);
	assert.deepEqual(page.fetched, []);
});

test("an export that comes back as the signed-out page stops the run with the auth code", async () => {
	const page = fakePage({
		route: (path) =>
			path.includes("/tick-export")
				? html(SIGNED_OUT_HTML, `${ORIGIN}${path}`)
				: signedInSite(path),
	});
	const h = harness(page, ALL);
	await assert.rejects(
		collectMountainProject(h.ctx, { requestDelayMs: 0 }),
		(error: unknown) => {
			assert.equal((error as { code?: string }).code, AUTH_FAILED);
			return true;
		},
	);
	assert.equal(of(h, "ticks").length, 0);
});

test("a rate-limited tick export fails that stream retryably and the to-do list still completes", async () => {
	const page = fakePage({
		route: (path) =>
			path.includes("/tick-export")
				? html("slow down", `${ORIGIN}${path}`, 429)
				: signedInSite(path),
	});
	const h = harness(page, ALL);
	await collectMountainProject(h.ctx, { requestDelayMs: 0 });
	assert.deepEqual(
		h.failures.map((f) => [f.stream, f.retryable]),
		[["ticks", true]],
	);
	assert.equal(typed(h, "DETAIL_COVERAGE", "ticks").length, 0);
	assert.equal(typed(h, "STATE", "ticks").length, 0);
	assert.equal(of(h, "saved_routes").length, 2);
	assert.equal(typed(h, "DETAIL_COVERAGE", "saved_routes").length, 1);
});

test("an export with a changed header fails that stream as needing a connector update", async () => {
	const page = fakePage({
		route: (path) =>
			path.includes("/todo-export")
				? csv("Route,Grade\nx,5.9\n", `${ORIGIN}${path}`)
				: signedInSite(path),
	});
	const h = harness(page, ALL);
	await collectMountainProject(h.ctx, { requestDelayMs: 0 });
	assert.deepEqual(
		h.failures.map((f) => [f.stream, f.retryable]),
		[["saved_routes", false]],
	);
	assert.equal(of(h, "ticks").length, 7);
});

test("an export shorter than the profile's count is emitted but not claimed complete", async () => {
	const page = fakePage({
		route: (path) =>
			path === `/user/${USER_ID}`
				? html(
						PROFILE_HTML.replace("View All 7", "View All 9"),
						`${ORIGIN}${PROFILE_PATH}`,
					)
				: signedInSite(path),
	});
	const h = harness(page, ["ticks"]);
	await collectMountainProject(h.ctx, { requestDelayMs: 0 });
	assert.equal(of(h, "ticks").length, 7);
	assert.equal(typed(h, "DETAIL_COVERAGE", "ticks").length, 0);
	assert.equal(typed(h, "STATE", "ticks").length, 0);
	const skip = typed(h, "SKIP_RESULT", "ticks");
	assert.equal(
		(skip[0] as { reason?: string }).reason,
		"export_shorter_than_profile_count",
	);
});

test("an unreadable export row is reported and the list is not claimed complete", async () => {
	const broken = TICK_CSV.replace(
		"https://www.mountainproject.com/route/105700002/sample-corner",
		"not-a-url",
	);
	const page = fakePage({
		route: (path) =>
			path.includes("/tick-export")
				? csv(broken, `${ORIGIN}${path}`)
				: signedInSite(path),
	});
	const h = harness(page, ["ticks"]);
	await collectMountainProject(h.ctx, { requestDelayMs: 0 });
	assert.equal(of(h, "ticks").length, 6);
	assert.equal(typed(h, "DETAIL_COVERAGE", "ticks").length, 0);
	const skip = typed(h, "SKIP_RESULT", "ticks");
	assert.equal((skip[0] as { reason?: string }).reason, "records_unreadable");
});

test("an empty export proves an empty list", async () => {
	const page = fakePage({
		route: (path) =>
			path.includes("/todo-export")
				? csv(`${TODO_CSV.split("\n")[0]}\n`, `${ORIGIN}${path}`)
				: path === `/user/${USER_ID}`
					? html(
							PROFILE_HTML.replace("Sort &amp; Filter All 2", ""),
							`${ORIGIN}${PROFILE_PATH}`,
						)
					: signedInSite(path),
	});
	const h = harness(page, ["saved_routes"]);
	await collectMountainProject(h.ctx, { requestDelayMs: 0 });
	assert.equal(of(h, "saved_routes").length, 0);
	const coverage = typed(h, "DETAIL_COVERAGE", "saved_routes");
	assert.equal((coverage[0] as { considered?: number }).considered, 0);
	assert.equal(typed(h, "STATE", "saved_routes").length, 1);
});

test("a profile answered without the redirect still gets its slug from the page's canonical link", async () => {
	const page = fakePage({
		route: (path) =>
			path === `/user/${USER_ID}`
				? html(PROFILE_HTML, `${ORIGIN}/user/${USER_ID}`)
				: signedInSite(path),
	});
	const h = harness(page, ALL);
	await collectMountainProject(h.ctx, { requestDelayMs: 0 });
	assert.deepEqual(h.failures, []);
	assert.ok(page.fetched.includes(`${PROFILE_PATH}/tick-export`));
	assert.equal(
		of(h, "profile")[0]?.data.profile_url,
		`${ORIGIN}${PROFILE_PATH}`,
	);
});

test("a failed profile read fails the profile stream and the exports use a fallback path", async () => {
	const page = fakePage({
		route: (path) =>
			path === `/user/${USER_ID}`
				? html("oops", `${ORIGIN}${path}`, 500)
				: signedInSite(path),
	});
	const h = harness(page, ALL);
	await collectMountainProject(h.ctx, { requestDelayMs: 0 });
	assert.deepEqual(
		h.failures.map((f) => [f.stream, f.retryable]),
		[["profile", true]],
	);
	assert.ok(page.fetched.includes(`/user/${USER_ID}/profile/tick-export`));
	assert.equal(of(h, "ticks").length, 7);
	assert.equal(typed(h, "DETAIL_COVERAGE", "ticks").length, 1);
});

test("the time range is applied by the runtime and coverage counts only selected ticks", async () => {
	const page = fakePage({});
	const h = harness(page, ["ticks"]);
	h.ctx.isRecordSelected = (_stream, data) => String(data.date) >= "2026-01-01";
	await collectMountainProject(h.ctx, { requestDelayMs: 0 });
	const coverage = typed(h, "DETAIL_COVERAGE", "ticks");
	assert.equal((coverage[0] as { considered?: number }).considered, 6);
});

test("classifyResponse treats a redirect to the sign-in page as signed out", () => {
	const outcome = classifyResponse(
		html("login", `${ORIGIN}/auth/login`),
		"csv",
		"the tick export",
	);
	assert.equal(outcome.ok, false);
	if (!outcome.ok) assert.equal(outcome.failure.code, AUTH_FAILED);
	const wrongType = classifyResponse(
		html("<html></html>", `${ORIGIN}${PROFILE_PATH}/tick-export`),
		"csv",
		"the tick export",
	);
	assert.equal(wrongType.ok, false);
	if (!wrongType.ok)
		assert.equal(wrongType.failure.code, "mountain_project_invalid_payload");
});

test("the session probe never navigates and reads window.ap.config", async () => {
	const signedIn = fakePage({});
	assert.equal(await probeMountainProjectSession(signedIn), true);
	const signedOut = fakePage({ config: { isLoggedIn: 0 } });
	assert.equal(await probeMountainProjectSession(signedOut), false);
	const elsewhere = fakePage({ origin: "https://appleid.apple.com" });
	assert.equal(await probeMountainProjectSession(elsewhere), false);
	assert.deepEqual(elsewhere.gotos, []);
});

test("hasMountainProjectSession lands on the site before probing", async () => {
	const page = fakePage({ origin: "https://www.onxmaps.com" });
	assert.equal(await hasMountainProjectSession(page), true);
	assert.deepEqual(page.gotos, [HOME_URL]);
});
