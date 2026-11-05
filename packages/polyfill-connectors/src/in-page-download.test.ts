// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	decodeDataUrl,
	fetchSameOriginFile,
	formIntentUrl,
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
