// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseProfilePage } from "./parsers.ts";
import { openContributionPage } from "./index.ts";

const profile = '<span class="p-nickname">sample-user</span><span class="p-name"></span><div class="p-note"></div><img class="avatar-user" src="https://example.test/user.png"><ul class="vcard-details"></ul><a data-tab-item="overview">Overview</a><a data-tab-item="repositories"><span class="Counter">0</span></a><h2 id="js-contribution-activity-description">0 contributions</h2>';
for (const [heading, field, entry] of [
	["Organizations", "organizations", '<ul><li><span class="avatar-group-item" aria-label="sample-org"><img alt="@sample-org" src="https://example.test/avatar.png"></span></li></ul>'],
	["Achievements", "achievements", '<ul><li><img alt="Achievement: Sample Badge" src="https://example.test/badge.png"></li></ul>'],
	["Organizations", "organizations", '<div role="listitem"></div>'],
	["Organizations", "organizations", '<span class="avatar-group-item"></span>'],
	["Achievements", "achievements", '<img alt="Sample Badge" src="https://example.test/badge.png">'],
	["Organizations", "organizations", '<ul><li></li></ul>'],
] as const) {
	test(`heading-bound ${field} accounts for structural candidate ${entry}`, () => {
		const parsed = parseProfilePage(`${profile}<div><h2>${heading}</h2>${entry}</div>`, "https://github.com/sample-user");
		assert.equal(parsed.complete, false);
		assert.ok(parsed.unreadableFields.includes(field));
	});
}

test("heading-bound collections without entry structures are genuinely empty", () => {
	const parsed = parseProfilePage(profile + '<div><h2>Organizations</h2><ul></ul></div><div><h2>Achievements</h2><div></div></div>', "https://github.com/sample-user");
	assert.equal(parsed.complete, true);
	assert.deepEqual(parsed.row?.organizations, []);
	assert.deepEqual(parsed.row?.achievements, []);
});

test("contribution navigation never calls the unsupported Page.url facade", async () => {
	const currentUrl = "https://github.com/login?return_to=%2Fsample-user";
	const page = {
		goto: async () => undefined,
		waitForFunction: async () => ({ dispose: async () => undefined }),
		content: async () => "<main>Sign in</main>",
		url: () => { assert.fail("unsupported Page.url called"); },
		evaluate: async (fn: () => string) => {
			const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
			Object.defineProperty(globalThis, "location", { configurable: true, value: { href: currentUrl } });
			try { return fn(); }
			finally {
				if (previous) Object.defineProperty(globalThis, "location", previous);
				else Reflect.deleteProperty(globalThis, "location");
			}
		},
	};
	const observed = await openContributionPage(page as never, "https://github.com/sample-user");
	assert.equal(observed.currentUrl, currentUrl);
});

test("neither GitHub navigation path references Page.url", async () => {
	const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /page\.url\s*\(/u);
});

for (const [heading, field, href] of [
	["Organizations", "organizations", "/sample-org"],
	["Achievements", "achievements", "/sample-user?tab=achievements&achievement=sample"],
] as const) {
	const image = '<img alt="Sample Badge" src="https://example.test/badge.png">';
	const entry = `<li><span ${field === "organizations" ? 'class="avatar-group-item"' : 'role="listitem"'}><a href="${href}">${image}</a></span></li>`;
	test(`${field} consumes nested list-item and avatar structures for a parsed entry`, () => {
		const parsed = parseProfilePage(`${profile}<div><h2>${heading}</h2><ul>${entry}</ul></div>`, "https://github.com/sample-user");
		assert.equal(parsed.complete, true);
		assert.equal(parsed.row?.[field]?.length, 1);
	});
	for (const variant of [entry + "<li></li>", entry.replace("</a>", image + "</a>")]) {
		test(`${field} cannot consume an unparsed sibling or second image: ${variant}`, () => {
			const parsed = parseProfilePage(`${profile}<div><h2>${heading}</h2><ul>${variant}</ul></div>`, "https://github.com/sample-user");
			assert.equal(parsed.complete, false);
			assert.equal(parsed.row?.[field]?.length, 1);
			assert.ok(parsed.unreadableFields.includes(field));
		});
	}
}
