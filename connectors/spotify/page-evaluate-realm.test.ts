// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { spotifyPageCollector, spotifyPageEvaluateSource } from "./index.ts";

const NOT_PRESENT = Symbol("not present");

function realmWith(setup: string): vm.Context {
	const context = vm.createContext({
		URL,
		Set,
		TextEncoder,
		URLSearchParams,
		crypto: globalThis.crypto,
		atob,
		btoa,
		AbortController,
		setTimeout,
		clearTimeout,
		fetch: () => Promise.reject(new Error("synthetic_network_blocked")),
		document: { querySelectorAll: () => [] },
		window: { location: { href: "https://open.spotify.com/" } },
	});
	vm.runInContext(setup, context);
	return context;
}

const CASES: Array<[string, string]> = [
	["absent", ""],
	[
		"an unrelated callable",
		"globalThis.__name = function unrelated() { return 'x'; };",
	],
	["a non-callable value", "globalThis.__name = 42;"],
	[
		"a read-only property",
		"Object.defineProperty(globalThis, '__name', { value: 'ro', writable: false, configurable: false });",
	],
];

test("the serialized callback is shaped by tsx with a __name helper it does not define", () => {
	assert.match(spotifyPageCollector.toString(), /__name\(/);
});

for (const [label, setup] of CASES) {
	test(`serialized page callback runs and leaves __name untouched when global __name is ${label}`, async () => {
		const context = realmWith(setup);
		const read = () => {
			const d = Object.getOwnPropertyDescriptor(context, "__name");
			return d === undefined ? NOT_PRESENT : d;
		};
		const before = read();
		const pending = vm.runInContext(spotifyPageEvaluateSource([]), context);
		// With no network the callback fails inside its own work, after every
		// nested declaration and `__name(...)` call has already run. A missing
		// or non-callable helper would surface as a ReferenceError/TypeError.
		await assert.rejects(
			() => pending,
			(error: Error) => /synthetic_network_blocked/.test(String(error.message)),
		);
		assert.deepEqual(read(), before);
	});
}
