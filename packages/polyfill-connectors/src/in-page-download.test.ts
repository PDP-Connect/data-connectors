// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	armDownloadCapture,
	type DownloadIntent,
	decodeDataUrl,
	disarmDownloadCapture,
	type EvaluatingPage,
	fetchSameOriginFile,
	formIntentUrl,
	waitForDownloadIntent,
} from "./in-page-download.ts";

test("formIntentUrl replaces overridden fields in place and appends new ones", () => {
	const url = formIntentUrl(
		{
			kind: "form",
			method: "GET",
			action: "https://bank.example/export?stale=1",
			fields: [
				["type", "CSV"],
				["token", "abc"],
				["type", "CSV"],
			],
		},
		{ type: "QFX", start: "20260101" },
	);
	assert.equal(
		url,
		"https://bank.example/export?type=QFX&token=abc&start=20260101",
	);
});

test("decodeDataUrl reads percent-encoded and base64 payloads", () => {
	const text = decodeDataUrl(
		"data:text/csv;charset=utf-8,Date%2CAmount%0A01%2F02%2F2026%2C-4.50",
	);
	assert.equal(text.mediaType, "text/csv;charset=utf-8");
	assert.equal(
		new TextDecoder().decode(text.bytes),
		"Date,Amount\n01/02/2026,-4.50",
	);
	const binary = decodeDataUrl("data:application/pdf;base64,JVBERg==");
	assert.equal(binary.mediaType, "application/pdf");
	assert.deepEqual([...binary.bytes], [0x25, 0x50, 0x44, 0x46]);
	assert.throws(
		() => decodeDataUrl("blob:https://bank.example/1"),
		/not a data URL/,
	);
});

test("fetchSameOriginFile refuses a cross-origin URL before fetching", async () => {
	const calls: string[] = [];
	const page = {
		evaluate: async <R, A>(
			fn: (arg: A) => R | Promise<R>,
			arg: A,
		): Promise<R> => {
			calls.push(JSON.stringify(arg));
			const saved = globalThis.location;
			Object.defineProperty(globalThis, "location", {
				configurable: true,
				value: new URL("https://bank.example/home"),
			});
			try {
				return await fn(arg);
			} finally {
				Object.defineProperty(globalThis, "location", {
					configurable: true,
					value: saved,
				});
			}
		},
	};
	const result = await fetchSameOriginFile(
		page,
		"https://other.example/file.csv",
		{ as: "text" },
	);
	assert.equal(result.ok, false);
	assert.equal(result.error, "cross_origin");
	assert.equal(calls.length, 1);
});

/**
 * Run `fn` with the page globals `armDownloadCapture` touches stubbed on
 * `globalThis`, then put the originals back.
 */
async function withStubPage<T>(fn: () => Promise<T>): Promise<T> {
	const g = globalThis as unknown as Record<string, unknown>;
	const names = [
		"window",
		"location",
		"document",
		"open",
		"addEventListener",
		"removeEventListener",
		"HTMLAnchorElement",
		"HTMLFormElement",
		"HTMLIFrameElement",
		"HTMLButtonElement",
		"HTMLInputElement",
		"FileReader",
	];
	const saved = names.map(
		(name) => [name, Object.getOwnPropertyDescriptor(g, name)] as const,
	);
	const set = (name: string, value: unknown): void => {
		Object.defineProperty(g, name, {
			configurable: true,
			writable: true,
			value,
		});
	};
	const realOpen = (): null => {
		throw new Error("the stub must not call the real window.open");
	};
	set("window", globalThis);
	set("location", { href: "https://bank.example/dashboard" });
	set("document", { addEventListener() {}, removeEventListener() {} });
	set("open", realOpen);
	set("addEventListener", () => undefined);
	set("removeEventListener", () => undefined);
	set(
		"HTMLAnchorElement",
		class {
			click(): void {}
		},
	);
	set(
		"HTMLFormElement",
		class {
			submit(): void {}
		},
	);
	set("HTMLIFrameElement", class {});
	set("HTMLButtonElement", class {});
	set("HTMLInputElement", class {});
	set("FileReader", class {});
	try {
		return await fn();
	} finally {
		for (const [name, descriptor] of saved) {
			if (descriptor) Object.defineProperty(g, name, descriptor);
			else delete g[name];
		}
	}
}

test("armDownloadCapture: window.open records the intent and returns a window that does not navigate", async () => {
	const page: EvaluatingPage = {
		evaluate: async <R, A>(
			fn: (arg: A) => R | Promise<R>,
			arg: A,
		): Promise<R> => fn(arg),
	};
	await withStubPage(async () => {
		assert.equal(await armDownloadCapture(page), true);
		const opened = (
			globalThis as unknown as {
				open: (url?: string, target?: string) => Window | null;
			}
		).open("", "_self");
		// chase.com submits its download form only when this is a window.
		assert.notEqual(opened, null);
		assert.equal(opened?.closed, false);
		assert.equal(opened?.name, "_self");
		opened?.focus();
		opened?.document.write("");
		opened?.close();
		assert.equal(opened?.closed, true);
		const intent: DownloadIntent | null = await waitForDownloadIntent(page, {
			timeoutMs: 0,
		});
		assert.deepEqual(intent, {
			kind: "open",
			url: "https://bank.example/dashboard",
		});
		await disarmDownloadCapture(page);
		assert.throws(
			() => (globalThis as unknown as { open: () => unknown }).open(),
			/must not call the real window.open/,
		);
	});
});
