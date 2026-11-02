// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { collectSpotifyMobileData } from "./mobile.ts";

const PLAYER = "https://open.spotify.com/";

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

// A page whose document can be replaced between bridge calls, as a load that
// commits after the host's goto has returned replaces it.
function fakePage(first: vm.Context, afterInstall: (installs: number) => vm.Context | null) {
	let current = first;
	const state = { installs: 0, gotos: [] as string[] };
	const page = {
		async evaluate(fn: string | ((arg: unknown) => unknown), arg?: unknown) {
			const source = typeof fn === "string"
				? fn
				: "(" + fn.toString() + ")(" + (arg === undefined ? "" : JSON.stringify(arg)) + ")";
			const value = await vm.runInContext(source, current);
			if (typeof fn === "string") {
				state.installs += 1;
				const next = afterInstall(state.installs);
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

test("a job installed in a document that is then replaced is collected again on the new one", async () => {
	const { page, state } = fakePage(documentAt(PLAYER), (installs) =>
		installs === 1 ? documentAt(PLAYER) : null);
	await assert.rejects(
		() => collectSpotifyMobileData(page, ["profile"]),
		(error: Error) => error.message === "synthetic_network_blocked",
	);
	assert.equal(state.installs, 2);
	assert.deepEqual(state.gotos, []);
});

test("an install before the player root settles navigates to the player and collects again", async () => {
	const { page, state } = fakePage(documentAt(PLAYER + "intl-de/"), () => null);
	await assert.rejects(
		() => collectSpotifyMobileData(page, ["profile"]),
		(error: Error) => error.message === "synthetic_network_blocked",
	);
	assert.equal(state.installs, 2);
	assert.deepEqual(state.gotos, [PLAYER]);
});

test("a document that keeps being replaced fails as a lost job after a bounded number of installs", async () => {
	const { page, state } = fakePage(documentAt(PLAYER), () => documentAt(PLAYER));
	await assert.rejects(
		() => collectSpotifyMobileData(page, ["profile"]),
		(error: Error) => error.message === "spotify_mobile_job_lost",
	);
	assert.equal(state.installs, 3);
});

test("an error raised by the collector is not retried", async () => {
	const { page, state } = fakePage(documentAt(PLAYER), () => null);
	await assert.rejects(
		() => collectSpotifyMobileData(page, ["profile"]),
		(error: Error) => error.message === "synthetic_network_blocked",
	);
	assert.equal(state.installs, 1);
});
