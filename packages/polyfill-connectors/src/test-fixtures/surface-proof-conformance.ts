// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { type Browser, chromium, type Page } from "playwright";

import type {
	ProofInput,
	ProofResult,
	SurfaceBinding,
} from "../surface-proof.ts";

const PAGE_URL = "https://proof.example/surface";
const API_URL = "https://proof.example/api";
const domBinding: SurfaceBinding = {
	kind: "dom",
	pageUrl: /^https:\/\/proof\.example\/surface$/,
	containerSelector: '[role="dialog"]',
	ownerSelector: '[data-owner="true"]',
	itemSelector: '[role="listitem"]',
	emptySelector: '[data-empty="true"]',
	emptyText: "No items",
};
const networkBinding: SurfaceBinding = {
	kind: "network",
	pageUrl: /^https:\/\/proof\.example\/surface$/,
	responseUrl: /^https:\/\/proof\.example\/api$/,
	operationName: "RequestedList",
	ownerPath: ["data", "owner", "id"],
	itemsPath: ["data", "requested", "edges"],
	pagination: {
		kind: "has-next",
		path: ["data", "requested", "page_info", "has_next_page"],
	},
};

function domHtml(dialog: string, extra = ""): string {
	return `<html><body><span data-owner="true">owner-1</span>${dialog}${extra}</body></html>`;
}

const emptyDialog =
	'<div role="dialog"><div data-empty="true">No items</div></div>';

async function domInput(
	browser: Browser,
	html: string,
	status = 200,
): Promise<{ page: Page; input: ProofInput }> {
	const page = await browser.newPage();
	await page.route(PAGE_URL, (route) =>
		route.fulfill({ status, contentType: "text/html", body: html }),
	);
	return {
		page,
		input: {
			page,
			navigate: () => page.goto(PAGE_URL),
			surface: domBinding,
			expectedOwner: "owner-1",
		},
	};
}

interface NetworkCase {
	readonly body: unknown;
	readonly operation?: string;
	readonly pageHtml?: string;
	readonly pageStatus?: number;
	readonly responseUrl?: string;
	readonly status?: number;
}

async function networkInput(
	browser: Browser,
	fixture: NetworkCase,
): Promise<{ page: Page; input: ProofInput }> {
	const page = await browser.newPage();
	await page.route(PAGE_URL, (route) =>
		route.fulfill({
			status: fixture.pageStatus ?? 200,
			contentType: "text/html",
			body: fixture.pageHtml ?? "<html><body>Account</body></html>",
		}),
	);
	await page.route("https://proof.example/**/api", (route) =>
		route.fulfill({
			status: fixture.status ?? 200,
			contentType: "application/json",
			body: JSON.stringify(fixture.body),
		}),
	);
	await page.route(API_URL, (route) =>
		route.fulfill({
			status: fixture.status ?? 200,
			contentType: "application/json",
			body: JSON.stringify(fixture.body),
		}),
	);
	const responseUrl = fixture.responseUrl ?? API_URL;
	return {
		page,
		input: {
			page,
			surface: networkBinding,
			expectedOwner: "owner-1",
			navigate: async () => {
				await page.goto(PAGE_URL);
				await page.evaluate(
					async ({ url, operation }) => {
						await fetch(url, {
							method: "POST",
							body: JSON.stringify({ operationName: operation }),
						});
					},
					{ url: responseUrl, operation: fixture.operation ?? "RequestedList" },
				);
			},
		},
	};
}

const validBody = {
	data: {
		owner: { id: "owner-1" },
		requested: { edges: [], page_info: { has_next_page: false } },
	},
};

// This table is the reusable adversarial contract for a connector's empty/identity
// binding: swap in the connector's surface binding and its navigation action.
export interface ProofUnderTest {
	readonly proveEmpty: (input: ProofInput) => Promise<ProofResult>;
	readonly proveIdentity: (input: ProofInput) => Promise<ProofResult>;
}

/** Run the same browser fixtures against the primitive or a connector adapter. */
export function runSurfaceProofConformance(proof: ProofUnderTest): void {
	test("surface proof conformance: DOM adversarial fixtures", async (t) => {
		const browser = await chromium.launch({ headless: true });
		try {
			const identityFailures = new Set([
				"error page",
				"login or challenge page",
				"display contents rendered error",
				"display contents loading",
				"plain loading text",
				"display contents busy ancestor",
				"wrong owner",
			]);
			const cases = [
				{
					name: "error page",
					html: domHtml('<div role="alert">Something went wrong</div>'),
				},
				{
					name: "login or challenge page",
					html: domHtml(`<form><input type="password"></form>${emptyDialog}`),
				},
				{
					name: "hidden empty marker",
					html: domHtml(
						'<div role="dialog"><div data-empty="true" hidden>No items</div></div>',
					),
				},
				{
					name: "display contents rendered error",
					html: domHtml(
						'<div role="dialog"><div role="alert" style="display:contents">Could not be loaded</div><div data-empty="true">No items</div></div>',
					),
				},
				{
					name: "display contents loading",
					html: domHtml(
						'<div role="dialog"><div role="progressbar" style="display:contents">Loading</div><div data-empty="true">No items</div></div>',
					),
				},
				{
					name: "plain loading text",
					html: domHtml(
						'<div role="dialog"><div data-empty="true">No items</div><div>Loading...</div></div>',
					),
				},
				{
					name: "display contents busy ancestor",
					html: domHtml(
						'<div role="dialog"><div aria-busy="true" style="display:contents"><div data-empty="true">No items</div></div></div>',
					),
				},
				{
					name: "off-screen empty marker",
					html: domHtml(
						'<div role="dialog"><div data-empty="true" style="position:absolute;left:-10000px">No items</div></div>',
					),
				},
				{
					name: "unrelated empty elsewhere",
					html: domHtml(
						'<div role="dialog"><div role="listitem">Travel</div></div>',
						'<aside data-empty="true">No items</aside>',
					),
				},
				{
					name: "partial render",
					html: domHtml(
						`<div role="dialog"><div data-empty="true">No items</div><div role="listitem" style="display:none" id="later">Travel</div></div><script>setTimeout(() => { document.querySelector('#later').style.display = 'block' }, 800)</script>`,
					),
				},
				{
					name: "inactive dialog hides active data",
					html: domHtml(
						`<div role="dialog" aria-hidden="true"><div data-empty="true">No items</div></div><div role="dialog"><div role="listitem">Travel</div></div>`,
					),
				},
				{
					name: "pagination pending",
					html: domHtml(
						`<div role="dialog"><div data-empty="true">No items</div><a rel="next" href="/next">Next</a></div>`,
					),
				},
				{
					name: "wrong owner",
					html: `<html><body><span data-owner="true">other</span>${emptyDialog}</body></html>`,
				},
				{
					name: "blank empty marker",
					html: domHtml(
						'<div role="dialog"><div data-empty="true"></div></div>',
					),
				},
			];
			for (const fixture of cases) {
				await t.test(fixture.name, async () => {
					const { page, input } = await domInput(browser, fixture.html);
					try {
						assert.equal((await proof.proveEmpty(input)).proven, false);
						if (identityFailures.has(fixture.name))
							assert.equal((await proof.proveIdentity(input)).proven, false);
					} finally {
						await page.close();
					}
				});
			}
			await t.test("non-2xx document", async () => {
				const { page, input } = await domInput(
					browser,
					domHtml(emptyDialog),
					500,
				);
				try {
					assert.equal((await proof.proveEmpty(input)).proven, false);
					assert.equal((await proof.proveIdentity(input)).proven, false);
				} finally {
					await page.close();
				}
			});
			await t.test("explicit visible empty and owner prove", async () => {
				const { page, input } = await domInput(browser, domHtml(emptyDialog));
				try {
					const result = await proof.proveEmpty(input);
					assert.equal(result.proven, true, JSON.stringify(result));
					assert.equal((await proof.proveIdentity(input)).proven, true);
				} finally {
					await page.close();
				}
			});
			await t.test("identity rejects loading nav text", async () => {
				const { page, input } = await domInput(
					browser,
					`<html><body><span data-owner="true">Loading...</span>${emptyDialog}</body></html>`,
				);
				try {
					assert.equal((await proof.proveIdentity(input)).proven, false);
				} finally {
					await page.close();
				}
			});
			await t.test("navigation timeout", async () => {
				const { page, input } = await domInput(browser, domHtml(emptyDialog));
				try {
					assert.equal(
						(
							await proof.proveEmpty({
								...input,
								navigate: () => new Promise(() => undefined),
							})
						).proven,
						false,
					);
				} finally {
					await page.close();
				}
			});
		} finally {
			await browser.close();
		}
	});

	test("surface proof conformance: network adversarial fixtures", async (t) => {
		const browser = await chromium.launch({ headless: true });
		try {
			const identityFailures = new Set([
				"response from different operation",
				"response from different URL",
				"non-2xx response",
				"wrong owner",
				"error envelope",
				"nested error envelope",
				"sign-in page with valid JSON",
				"identity challenge page with valid JSON",
				"non-2xx page",
			]);
			const cases: readonly { name: string; fixture: NetworkCase }[] = [
				{
					name: "response from different operation",
					fixture: { body: validBody, operation: "UnrelatedQuery" },
				},
				{
					name: "response from different URL",
					fixture: {
						body: validBody,
						responseUrl: "https://proof.example/other/api",
					},
				},
				{ name: "non-2xx response", fixture: { body: validBody, status: 500 } },
				{
					name: "wrong owner",
					fixture: {
						body: {
							...validBody,
							data: { ...validBody.data, owner: { id: "other" } },
						},
					},
				},
				{
					name: "source has an unkeyed item",
					fixture: {
						body: {
							...validBody,
							data: {
								...validBody.data,
								requested: { edges: [{}], page_info: { has_next_page: false } },
							},
						},
					},
				},
				{
					name: "pagination pending",
					fixture: {
						body: {
							...validBody,
							data: {
								...validBody.data,
								requested: { edges: [], page_info: { has_next_page: true } },
							},
						},
					},
				},
				{
					name: "pagination missing",
					fixture: {
						body: {
							...validBody,
							data: {
								...validBody.data,
								requested: { edges: [], page_info: {} },
							},
						},
					},
				},
				{
					name: "error envelope",
					fixture: { body: { ...validBody, errors: [{ message: "Sign in" }] } },
				},
				{
					name: "nested error envelope",
					fixture: {
						body: {
							...validBody,
							data: { ...validBody.data, error: "Sign in" },
						},
					},
				},
				{
					name: "sign-in page with valid JSON",
					fixture: {
						body: validBody,
						pageHtml:
							'<html><body><form><input type="password"></form></body></html>',
					},
				},
				{
					name: "identity challenge page with valid JSON",
					fixture: {
						body: validBody,
						pageHtml: "<html><body>Verify your identity</body></html>",
					},
				},
				{
					name: "visible next link contradicts terminal JSON",
					fixture: {
						body: validBody,
						pageHtml:
							'<html><body>Account <a rel="next" href="/next">Next</a></body></html>',
					},
				},
				{
					name: "unrelated empty list",
					fixture: {
						body: {
							data: {
								owner: { id: "owner-1" },
								requested: {
									edges: [{ id: "1" }],
									page_info: { has_next_page: false },
								},
								sidebar: { edges: [] },
							},
						},
					},
				},
				{ name: "non-2xx page", fixture: { body: validBody, pageStatus: 500 } },
			];
			for (const { name, fixture } of cases) {
				await t.test(name, async () => {
					const { page, input } = await networkInput(browser, fixture);
					try {
						assert.equal((await proof.proveEmpty(input)).proven, false);
						if (identityFailures.has(name))
							assert.equal((await proof.proveIdentity(input)).proven, false);
					} finally {
						await page.close();
					}
				});
			}
			await t.test("explicit terminal empty and owner prove", async () => {
				const { page, input } = await networkInput(browser, {
					body: validBody,
				});
				try {
					assert.equal((await proof.proveEmpty(input)).proven, true);
				} finally {
					await page.close();
				}
			});
			await t.test("network identity proves only the bound owner", async () => {
				const { page, input } = await networkInput(browser, {
					body: validBody,
				});
				try {
					assert.equal((await proof.proveIdentity(input)).proven, true);
				} finally {
					await page.close();
				}
			});
		} finally {
			await browser.close();
		}
	});
}
