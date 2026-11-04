// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { collectSpotifyMobileData } from "./mobile.ts";

const PLAYER = "https://open.spotify.com/";

// What the page facade raises when the host answered a bridge call with
// nothing because the WebView was committing a new document (see
// boundedPageEvaluate in scripts/pageshim/runtime.ts).
const MARKER_ERROR = "PageShim evaluation returned an invalid transfer marker";

// A page document. Its network is blocked, so a collector that runs in it
// fails with its own error once it asks for the access token.
function documentAt(href: string): vm.Context {
	const location = { href, origin: new URL(href).origin };
	const context = vm.createContext({
		URL,
		Set,
		Response,
		TextEncoder,
		URLSearchParams,
		crypto: globalThis.crypto,
		AbortController,
		setTimeout,
		clearTimeout,
		__name: (target: unknown) => target,
		location,
		window: { location },
		document: { readyState: "complete", querySelectorAll: () => [] },
	});
	// The rejection is the page realm's own Error, as a real page fetch's is.
	vm.runInContext(
		"globalThis.fetch = () => Promise.reject(new Error('synthetic_network_blocked'));",
		context,
	);
	return context;
}

// The bridge calls collectSpotifyMobileData makes, told apart by the code
// they send to the page.
type BridgeCall = "install" | "pump" | "read" | "dispose" | "probe";

function bridgeCallOf(fn: string | ((arg: unknown) => unknown)): BridgeCall {
	if (typeof fn === "string") return "install";
	const source = fn.toString();
	if (source.includes(".pump()")) return "pump";
	if (source.includes(".read(")) return "read";
	if (source.includes(".dispose()")) return "dispose";
	if (source.includes("readyState")) return "probe";
	throw new Error("unexpected bridge call: " + source);
}

type FakePageOptions = {
	// The document that replaces the current one after the n-th install, if any.
	afterInstall?: (installs: number) => vm.Context | null;
	// The error the host raises for the n-th call of a kind, if any.
	fail?: (call: BridgeCall, nth: number) => Error | undefined;
};

// A page whose document can be replaced between bridge calls, as a load that
// commits after the host's goto has returned replaces it, and whose bridge can
// fail a call, as one that runs while the document commits fails.
function fakePage(first: vm.Context, options: FakePageOptions = {}) {
	let current = first;
	const state = {
		installs: 0,
		gotos: [] as string[],
		calls: { install: 0, pump: 0, read: 0, dispose: 0, probe: 0 } as Record<BridgeCall, number>,
	};
	const page = {
		async evaluate(fn: string | ((arg: unknown) => unknown), arg?: unknown) {
			const call = bridgeCallOf(fn);
			state.calls[call] += 1;
			if (call === "install") state.installs += 1;
			const failure = options.fail?.(call, state.calls[call]);
			if (failure) throw failure;
			const source = typeof fn === "string"
				? fn
				: "(" + fn.toString() + ")(" + (arg === undefined ? "" : JSON.stringify(arg)) + ")";
			const value = await vm.runInContext(source, current);
			if (call === "install") {
				const next = options.afterInstall?.(state.installs);
				if (next) current = next;
			}
			return value;
		},
		async goto(url: string) {
			state.gotos.push(url);
			current = documentAt(url);
		},
	};
	return { page: page as unknown as Parameters<typeof collectSpotifyMobileData>[0], state };
}

const rejectsWith = (message: string) => (error: Error) => error.message === message;

test("a job installed in a document that is then replaced is collected again on the new one", async () => {
	const { page, state } = fakePage(documentAt(PLAYER), {
		afterInstall: (installs) => installs === 1 ? documentAt(PLAYER) : null,
	});
	await assert.rejects(
		() => collectSpotifyMobileData(page, ["profile"]),
		rejectsWith("synthetic_network_blocked"),
	);
	assert.equal(state.installs, 2);
	assert.deepEqual(state.gotos, []);
});

test("an install before the player root settles navigates to the player and collects again", async () => {
	const { page, state } = fakePage(documentAt(PLAYER + "intl-de/"));
	await assert.rejects(
		() => collectSpotifyMobileData(page, ["profile"]),
		rejectsWith("synthetic_network_blocked"),
	);
	assert.equal(state.installs, 2);
	assert.deepEqual(state.gotos, [PLAYER]);
});

test("a document that keeps being replaced fails as a lost job after a bounded number of installs", async () => {
	const { page, state } = fakePage(documentAt(PLAYER), {
		afterInstall: () => documentAt(PLAYER),
	});
	await assert.rejects(
		() => collectSpotifyMobileData(page, ["profile"]),
		rejectsWith("spotify_mobile_job_lost"),
	);
	assert.equal(state.installs, 3);
});

test("an error raised by the collector is not retried", async () => {
	const { page, state } = fakePage(documentAt(PLAYER));
	await assert.rejects(
		() => collectSpotifyMobileData(page, ["profile"]),
		rejectsWith("synthetic_network_blocked"),
	);
	assert.equal(state.installs, 1);
});

test("a dispose that fails while the document commits does not hide the lost job", async () => {
	// The pump finds no job in the new document; the dispose that follows runs
	// against the same committing document and fails too. The lost job, not the
	// failed dispose, decides what happens next: collect again.
	const { page, state } = fakePage(documentAt(PLAYER), {
		afterInstall: (installs) => installs === 1 ? documentAt(PLAYER) : null,
		fail: (call, nth) => call === "dispose" && nth === 1 ? new Error(MARKER_ERROR) : undefined,
	});
	await assert.rejects(
		() => collectSpotifyMobileData(page, ["profile"]),
		rejectsWith("synthetic_network_blocked"),
	);
	assert.equal(state.installs, 2);
	assert.deepEqual(state.gotos, []);
	assert.equal(state.calls.dispose, 2);
});

test("a dispose that fails does not replace the collector's own error", async () => {
	const { page, state } = fakePage(documentAt(PLAYER), {
		fail: (call, nth) => call === "dispose" && nth === 1 ? new Error(MARKER_ERROR) : undefined,
	});
	await assert.rejects(
		() => collectSpotifyMobileData(page, ["profile"]),
		rejectsWith("synthetic_network_blocked"),
	);
	assert.equal(state.installs, 1);
});

test("a settle probe that runs while the document commits navigates to the player and collects again", async () => {
	const { page, state } = fakePage(documentAt(PLAYER), {
		afterInstall: (installs) => installs === 1 ? documentAt(PLAYER) : null,
		fail: (call, nth) => call === "probe" && nth === 1 ? new Error(MARKER_ERROR) : undefined,
	});
	await assert.rejects(
		() => collectSpotifyMobileData(page, ["profile"]),
		rejectsWith("synthetic_network_blocked"),
	);
	assert.equal(state.installs, 2);
	assert.deepEqual(state.gotos, [PLAYER]);
});

test("a pump that runs while the document commits is a lost document and is collected again", async () => {
	const { page, state } = fakePage(documentAt(PLAYER), {
		fail: (call, nth) => call === "pump" && nth === 1 ? new Error(MARKER_ERROR) : undefined,
	});
	await assert.rejects(
		() => collectSpotifyMobileData(page, ["profile"]),
		rejectsWith("synthetic_network_blocked"),
	);
	assert.equal(state.installs, 2);
	assert.deepEqual(state.gotos, []);
});

test("a bridge that keeps answering nothing fails with its error after a bounded number of installs", async () => {
	const { page, state } = fakePage(documentAt(PLAYER), {
		fail: (call) => call === "pump" ? new Error(MARKER_ERROR) : undefined,
	});
	await assert.rejects(
		() => collectSpotifyMobileData(page, ["profile"]),
		rejectsWith(MARKER_ERROR),
	);
	assert.equal(state.installs, 3);
});

test("a settle probe that fails for another reason fails the run", async () => {
	const { page, state } = fakePage(documentAt(PLAYER), {
		afterInstall: (installs) => installs === 1 ? documentAt(PLAYER) : null,
		fail: (call) => call === "probe" ? new Error("PageShim bridge call evaluate timed out after 30000ms") : undefined,
	});
	await assert.rejects(
		() => collectSpotifyMobileData(page, ["profile"]),
		rejectsWith("PageShim bridge call evaluate timed out after 30000ms"),
	);
	assert.equal(state.installs, 1);
	assert.deepEqual(state.gotos, []);
});
