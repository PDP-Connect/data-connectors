// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";
import type { Page } from "playwright";
import {
	classifyAdsDialogInPage,
	scrapeAdTopics,
	scrapeTargetingCategories,
} from "./index.ts";

type ClassifierArgs = Parameters<typeof classifyAdsDialogInPage>[0];
type Classification = ReturnType<typeof classifyAdsDialogInPage>;
type AdsClock = Parameters<typeof scrapeAdTopics>[1];

function parseStyle(raw: string | null): Record<string, string> {
	const out: Record<string, string> = {};
	for (const declaration of (raw ?? "").split(";")) {
		const [name, value] = declaration.split(":");
		if (name && value) {
			out[name.trim().toLowerCase()] = value.trim().toLowerCase();
		}
	}
	return out;
}

function classify(html: string, args: ClassifierArgs): Classification {
	const { document, window } = parseHTML(`<html><body>${html}</body></html>`);
	installGeometry(window);

	const result = runInNewContext(`(${String(classifyAdsDialogInPage)})(args)`, {
		args,
		document,
		getComputedStyle: (element: Element) => {
			const style = parseStyle(element.getAttribute("style"));
			return {
				display: style.display ?? "block",
				opacity: style.opacity ?? "1",
				visibility: style.visibility ?? "visible",
			};
		},
		NodeFilter: { SHOW_TEXT: 4 },
	}) as Classification;
	return JSON.parse(JSON.stringify(result)) as Classification;
}

function installGeometry(window: { Element: typeof Element }): void {
	const elementPrototype = window.Element
		.prototype as typeof window.Element.prototype & {
		getBoundingClientRect: () => {
			bottom: number;
			height: number;
			left: number;
			right: number;
			top: number;
			width: number;
			x: number;
			y: number;
		};
	};
	elementPrototype.getBoundingClientRect = function getBoundingClientRect() {
		const style = parseStyle(this.getAttribute("style"));
		const hidden =
			this.hasAttribute("hidden") ||
			style.display === "none" ||
			style.visibility === "hidden" ||
			style.visibility === "collapse" ||
			style.opacity === "0";
		const size = hidden ? 0 : 10;
		const height = style.height === "0" || style.height === "0px" ? 0 : size;
		return {
			bottom: height,
			height,
			left: 0,
			right: size,
			top: 0,
			width: size,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		};
	};
}

function makeClock(
	onSleep?: (now: number) => void,
): AdsClock & { nowValue: number } {
	const clock = {
		nowValue: 0,
		now: () => clock.nowValue,
		sleep: async (ms: number): Promise<void> => {
			clock.nowValue += ms;
			onSleep?.(clock.nowValue);
		},
	};
	return clock;
}

function makeDomPage(
	html: string,
	hooks: { onViewAllClick?: () => void } = {},
): { document: Document; page: Page; window: Window } {
	const { document, window } = parseHTML(`<html><body>${html}</body></html>`);
	installGeometry(window);
	const evaluate = (fn: unknown, arg?: unknown): Promise<unknown> => {
		const result = runInNewContext(`(${String(fn)})(arg)`, {
			arg,
			document,
			getComputedStyle: (element: Element) => {
				const style = parseStyle(element.getAttribute("style"));
				return {
					display: style.display ?? "block",
					opacity: style.opacity ?? "1",
					visibility: style.visibility ?? "visible",
				};
			},
			NodeFilter: { SHOW_TEXT: 4 },
		});
		if (result === true && String(fn).includes('button, [role="button"]')) {
			hooks.onViewAllClick?.();
		}
		if (result === undefined) {
			return Promise.resolve(undefined);
		}
		return Promise.resolve(JSON.parse(JSON.stringify(result)));
	};
	const page = {
		evaluate,
		goto: () => Promise.resolve(null),
		waitForFunction: (fn: unknown): Promise<unknown> =>
			evaluate(fn).then((value) => {
				if (!value) throw new Error("condition not ready");
				return value;
			}),
	} as unknown as Page;
	return { document, page, window };
}

const advertisersArgs = {
	emptyMessage: "No advertisers",
	requiredAffordance: "Remove",
	uiOnlyPatternSource: "\\bRemove\\b",
} satisfies ClassifierArgs;

test("classifyAdsDialogInPage: visible explicit empty message is verified empty", () => {
	assert.deepEqual(
		classify(
			`
				<section role="dialog">
					<div role="list"></div>
					<p>No advertisers</p>
				</section>
			`,
			advertisersArgs,
		),
		{ kind: "verified_empty" },
	);
});

test("classifyAdsDialogInPage: hidden empty messages do not prove empty", () => {
	assert.deepEqual(
		classify(
			`
				<section role="dialog">
					<div role="list"></div>
					<p style="display:none">No advertisers</p>
				</section>
			`,
			advertisersArgs,
		),
		{ kind: "unavailable" },
	);
});

test("classifyAdsDialogInPage: busy and loading surfaces stay loading", () => {
	for (const html of [
		`<section role="dialog" aria-busy="true"><div role="list"></div></section>`,
		`<section role="dialog"><div role="progressbar"></div><div role="list"></div></section>`,
		`<section role="dialog"><div role="list"></div><p>Please wait, loading</p></section>`,
	]) {
		assert.deepEqual(classify(html, advertisersArgs), { kind: "loading" });
	}
});

test("classifyAdsDialogInPage: alerts and error text are unavailable", () => {
	for (const html of [
		`<section role="dialog"><div role="alert">Could not be loaded</div><div role="list"></div></section>`,
		`<section role="dialog"><div role="list"></div><p>Something went wrong. Try again.</p></section>`,
	]) {
		assert.deepEqual(classify(html, advertisersArgs), { kind: "unavailable" });
	}
});

test("classifyAdsDialogInPage: hidden row plus visible empty message is not verified empty", () => {
	assert.notEqual(
		classify(
			`
				<section role="dialog">
					<div role="list">
						<div role="listitem" style="display:none">Acme<button>Remove</button></div>
					</div>
					<p>No advertisers</p>
				</section>
			`,
			advertisersArgs,
		).kind,
		"verified_empty",
	);
});

test("classifyAdsDialogInPage: unknown control-only rows are unavailable", () => {
	assert.deepEqual(
		classify(
			`
				<section role="dialog">
					<div role="list">
						<div role="listitem"><button>Unknown control</button></div>
					</div>
				</section>
			`,
			advertisersArgs,
		),
		{ kind: "unavailable" },
	);
});

test("classifyAdsDialogInPage: visible data without source total is data but incomplete", () => {
	assert.deepEqual(
		classify(
			`
				<section role="dialog">
					<div role="list">
						<div role="listitem">Acme <button>Remove</button></div>
					</div>
				</section>
			`,
			advertisersArgs,
		),
		{ complete: false, items: ["Acme"], kind: "data" },
	);
});

test("classifyAdsDialogInPage: data matching ARIA source total is complete", () => {
	assert.deepEqual(
		classify(
			`
				<section role="dialog">
					<div role="list" aria-setsize="2">
						<div role="listitem" aria-posinset="1">Acme <button>Remove</button></div>
						<div role="listitem" aria-posinset="2">Beta <button>Remove</button></div>
					</div>
				</section>
			`,
			advertisersArgs,
		),
		{ complete: true, items: ["Acme", "Beta"], kind: "data" },
	);
});

test("scrapeAdTopics: waits through hidden-then-revealed topic fixture before completing", async () => {
	const html = await readFile(
		new URL("./fixtures/ads.topics.hidden-then-revealed.html", import.meta.url),
		"utf8",
	);
	const { document, window } = parseHTML(html);
	let now = 0;
	let visibleSince: number | null = null;
	const topic = document.querySelector("#topic") as HTMLElement | null;
	assert.ok(topic, "fixture must include hidden topic span");

	const revealIfReady = (): void => {
		if (now >= 100 && topic.style.display === "none") {
			topic.style.display = "inline";
			visibleSince = now;
		}
	};
	const elementPrototype = window.Element
		.prototype as typeof window.Element.prototype & {
		getBoundingClientRect: () => {
			bottom: number;
			height: number;
			left: number;
			right: number;
			top: number;
			width: number;
			x: number;
			y: number;
		};
	};
	elementPrototype.getBoundingClientRect = function getBoundingClientRect() {
		const style = parseStyle(this.getAttribute("style"));
		const hidden =
			this.hasAttribute("hidden") ||
			style.display === "none" ||
			style.visibility === "hidden" ||
			style.visibility === "collapse" ||
			style.opacity === "0";
		const size = hidden ? 0 : 10;
		return {
			bottom: size,
			height: size,
			left: 0,
			right: size,
			top: 0,
			width: size,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		};
	};
	const evaluate = (fn: unknown, arg?: unknown): Promise<unknown> => {
		const result = runInNewContext(`(${String(fn)})(arg)`, {
			arg,
			document,
			getComputedStyle: (element: Element) => {
				const style = parseStyle(element.getAttribute("style"));
				return {
					display: style.display ?? "block",
					opacity: style.opacity ?? "1",
					visibility: style.visibility ?? "visible",
				};
			},
			NodeFilter: { SHOW_TEXT: 4 },
		});
		return Promise.resolve(JSON.parse(JSON.stringify(result)));
	};
	const page = {
		evaluate,
		goto: () => Promise.resolve(null),
		waitForFunction: (fn: unknown): Promise<unknown> =>
			evaluate(fn).then((value) => {
				if (!value) throw new Error("condition not ready");
				return value;
			}),
	} as unknown as Page;
	const clock = {
		now: () => now,
		sleep: async (ms: number): Promise<void> => {
			now += ms;
			revealIfReady();
		},
	};

	const result = await scrapeAdTopics(page, clock);

	assert.deepEqual(result, {
		items: ["Example Topic"],
		reached: true,
		step: null,
		surface: "ad_topics",
	});
	assert.ok(
		visibleSince !== null,
		"fixture topic should reveal during virtual time",
	);
	assert.ok(
		now - visibleSince >= 2_500,
		"topic must remain visible for the full settle window",
	);
});

test("classifyAdsDialogInPage: hidden stale dialogs are ignored", () => {
	assert.deepEqual(
		classify(
			`
				<section role="dialog" style="display:none">
					<div role="list" aria-setsize="1">
						<div role="listitem" aria-posinset="1">Stale <button>Remove</button></div>
					</div>
				</section>
				<section role="dialog">
					<div role="list" aria-setsize="1">
						<div role="listitem" aria-posinset="1">Current <button>Remove</button></div>
					</div>
				</section>
			`,
			advertisersArgs,
		),
		{ complete: true, items: ["Current"], kind: "data" },
	);
});

test("classifyAdsDialogInPage: malformed ARIA totals do not prove completion", () => {
	assert.deepEqual(
		classify(
			`
				<section role="dialog">
					<div role="list" aria-setsize="1junk">
						<div role="listitem" aria-posinset="1">Acme <button>Remove</button></div>
					</div>
				</section>
			`,
			advertisersArgs,
		),
		{ complete: false, items: ["Acme"], kind: "data" },
	);
});

test("classifyAdsDialogInPage: duplicate or missing positions do not prove completion", () => {
	assert.deepEqual(
		classify(
			`
				<section role="dialog">
					<div role="list" aria-setsize="2">
						<div role="listitem" aria-posinset="1">Acme <button>Remove</button></div>
						<div role="listitem">Beta <button>Remove</button></div>
					</div>
				</section>
			`,
			advertisersArgs,
		),
		{ complete: false, items: ["Acme", "Beta"], kind: "data" },
	);
	assert.deepEqual(
		classify(
			`
				<section role="dialog">
					<div role="list" aria-setsize="2">
						<div role="listitem" aria-posinset="1">Acme <button>Remove</button></div>
						<div role="listitem" aria-posinset="1">Beta <button>Remove</button></div>
					</div>
				</section>
			`,
			advertisersArgs,
		),
		{ complete: false, items: ["Acme", "Beta"], kind: "data" },
	);
});

test("classifyAdsDialogInPage: every visible list needs source total evidence", () => {
	assert.deepEqual(
		classify(
			`
				<section role="dialog">
					<div role="list" aria-setsize="1">
						<div role="listitem" aria-posinset="1">Acme <button>Remove</button></div>
					</div>
					<div role="list">
						<div role="listitem">Beta <button>Remove</button></div>
					</div>
				</section>
			`,
			advertisersArgs,
		),
		{ complete: false, items: ["Acme", "Beta"], kind: "data" },
	);
	assert.deepEqual(
		classify(
			`
				<section role="dialog">
					<div role="list" aria-setsize="1">
						<div role="listitem" aria-posinset="1">Acme <button>Remove</button></div>
					</div>
					<div role="list" aria-setsize="1">
						<div role="listitem" aria-posinset="1">Beta <button>Remove</button></div>
					</div>
				</section>
			`,
			advertisersArgs,
		),
		{ complete: true, items: ["Acme", "Beta"], kind: "data" },
	);
});

test("classifyAdsDialogInPage: hidden unresolved item text keeps the surface loading", () => {
	assert.deepEqual(
		classify(
			`
				<section role="dialog">
					<div role="list">
						<div role="listitem">
							<span style="display:none">Acme</span>
							<button>Remove</button>
						</div>
					</div>
					<p>No advertisers</p>
				</section>
			`,
			advertisersArgs,
		),
		{ kind: "loading" },
	);
	assert.deepEqual(
		classify(
			`
				<section role="dialog">
					<div role="list" aria-setsize="1">
						<div role="listitem" aria-posinset="1">Acme <button>Remove</button></div>
					</div>
					<div role="list">
						<div role="listitem" style="display:none">Beta <button>Remove</button></div>
					</div>
				</section>
			`,
			advertisersArgs,
		),
		{ kind: "loading" },
	);
});

test("scrapeTargetingCategories: extracts all visible category lists", async () => {
	const { page } = makeDomPage(`
		<div role="tab">Manage info</div>
		<div role="tabpanel"><a>Categories used to reach you</a></div>
		<section role="dialog">
			<div role="list" aria-setsize="1">
				<div role="listitem" aria-posinset="1"><span>Music</span><span>Based on activity</span><button>Remove</button></div>
			</div>
			<div role="list" aria-setsize="1">
				<div role="listitem" aria-posinset="1"><span>Travel</span><span>Based on visits</span><button>Remove</button></div>
			</div>
		</section>
	`);

	assert.deepEqual(await scrapeTargetingCategories(page, makeClock()), {
		items: [
			{ description: "Based on activity", name: "Music" },
			{ description: "Based on visits", name: "Travel" },
		],
		reached: true,
		step: null,
		surface: "targeting_categories",
	});
});

test("scrapeTargetingCategories: waits for rows appended after visible View all", async () => {
	let clickedAt: number | null = null;
	const clock = makeClock((now) => {
		if (clickedAt !== null && now - clickedAt >= 500) {
			const list = document.querySelector("#category-list");
			if (list && !document.querySelector("#appended-category")) {
				list.insertAdjacentHTML(
					"beforeend",
					`<div id="appended-category" role="listitem" aria-posinset="2"><span>Travel</span><span>Based on visits</span><button>Remove</button></div>`,
				);
			}
		}
	});
	const { document, page } = makeDomPage(
		`
		<div role="tab">Manage info</div>
		<div role="tabpanel"><a>Categories used to reach you</a></div>
		<section role="dialog">
			<div id="category-list" role="list" aria-setsize="2">
				<div role="listitem" aria-posinset="1"><span>Music</span><span>Based on activity</span><button>Remove</button></div>
			</div>
			<button id="view-all">View all</button>
		</section>
	`,
		{
			onViewAllClick: () => {
				clickedAt = clickedAt ?? clock.nowValue;
				const viewAll = document.querySelector(
					"#view-all",
				) as HTMLElement | null;
				if (viewAll) viewAll.style.display = "none";
			},
		},
	);

	assert.deepEqual(await scrapeTargetingCategories(page, clock), {
		items: [
			{ description: "Based on activity", name: "Music" },
			{ description: "Based on visits", name: "Travel" },
		],
		reached: true,
		step: null,
		surface: "targeting_categories",
	});
	assert.ok(clock.nowValue >= 3_000);
});

test("scrapeTargetingCategories: an empty message after View all cannot erase categories already seen", async () => {
	const { document, page } = makeDomPage(
		`
		<div role="tab">Manage info</div>
		<div role="tabpanel"><a>Categories used to reach you</a></div>
		<section id="categories" role="dialog">
			<div role="list" aria-setsize="2">
				<div role="listitem" aria-posinset="1"><span>Music</span><button>Remove</button></div>
				<div role="listitem" aria-posinset="2"><span>Travel</span><button>Remove</button></div>
			</div>
			<button>View all</button>
		</section>
	`,
		{
			onViewAllClick: () => {
				const dialog = document.querySelector("#categories");
				if (dialog) {
					dialog.innerHTML = `<div role="list"></div><p>No categories</p>`;
				}
			},
		},
	);

	const result = await scrapeTargetingCategories(page, makeClock());
	assert.equal(result.reached, false);
	assert.equal(result.step, "destination_list_not_found");
});

test("scrapeTargetingCategories: hidden View all without count evidence does not complete", async () => {
	const { page } = makeDomPage(`
		<div role="tab">Manage info</div>
		<div role="tabpanel"><a>Categories used to reach you</a></div>
		<section role="dialog">
			<div role="list">
				<div role="listitem"><span>Music</span><span>Based on activity</span><button>Remove</button></div>
			</div>
			<button style="display:none">View all</button>
		</section>
	`);

	assert.deepEqual(await scrapeTargetingCategories(page, makeClock()), {
		items: [{ description: "Based on activity", name: "Music" }],
		reached: false,
		step: "destination_list_not_found",
		surface: "targeting_categories",
	});
});

test("scrapeTargetingCategories: extraction stays in the dialog whose source total was settled", async () => {
	const { page } = makeDomPage(`
  <div role="tab">Manage info</div>
  <div role="tabpanel"><a>Categories used to reach you</a></div>
  <section role="dialog"><div role="list" aria-setsize="1">
   <div role="listitem" aria-posinset="1"><span>Music</span><button>Remove</button></div>
  </div></section>
  <section role="dialog"><div role="list">
   <div role="listitem"><span>Stale category</span><button>Remove</button></div>
  </div></section>
 `);
	assert.deepEqual(await scrapeTargetingCategories(page, makeClock()), {
		items: [{ description: null, name: "Music" }],
		reached: true,
		step: null,
		surface: "targeting_categories",
	});
});

test("classifyAdsDialogInPage: known UI-only topic rows require an explicit empty message", () => {
	for (const marker of ["", "<p>No ad topics</p>"]) {
		assert.deepEqual(
			classify(
				`<section role="dialog"><div role="list"><div role="listitem"><span>Special topic</span><button>See less</button></div></div>${marker}</section>`,
				{
					emptyMessage: "No ad topics",
					uiOnlyPatternSource: "^(?:special topic|see less)$",
				},
			),
			{ kind: marker ? "verified_empty" : "unavailable" },
		);
	}
});

for (const replacement of [
	"<p role='alert'>Something went wrong</p>",
	"<div role='progressbar'>Loading</div>",
]) {
	test(`scrapeTargetingCategories: ${replacement.includes("alert") ? "error" : "loading"} after View all prevents completion`, async () => {
		const { document, page } = makeDomPage(
			`
   <div role="tab">Manage info</div><div role="tabpanel"><a>Categories used to reach you</a></div>
   <section role="dialog"><div role="list" aria-setsize="2"><div role="listitem" aria-posinset="1"><span>Music</span><button>Remove</button></div></div><button id="view-all">View all</button></section>
  `,
			{
				onViewAllClick: () => {
					document.querySelector("#view-all")?.remove();
					document
						.querySelector('[role="list"]')
						?.insertAdjacentHTML("afterend", replacement);
				},
			},
		);
		const result = await scrapeTargetingCategories(page, makeClock());
		assert.equal(result.reached, false);
		assert.deepEqual(result.items, []);
	});
}

test("classifyAdsDialogInPage: visible source empty message proves a zero-height list", () => {
	assert.deepEqual(
		classify(
			'<section role="dialog"><div role="list" style="height:0"></div><p>No advertisers</p></section>',
			advertisersArgs,
		),
		{ kind: "verified_empty" },
	);
});
