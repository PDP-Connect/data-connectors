// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Page, Response } from "playwright";

/** A binding names the requested page and the evidence on that page. */
export type SurfaceBinding =
	| {
			readonly kind: "dom";
			readonly pageUrl: RegExp;
			readonly containerSelector: string;
			readonly ownerSelector: string;
			readonly itemSelector: string;
			readonly emptySelector: string;
			readonly emptyText: string;
	  }
	| {
			readonly kind: "network";
			readonly pageUrl: RegExp;
			readonly responseUrl: RegExp;
			readonly operationName?: string;
			readonly ownerPath: readonly (string | number)[];
			readonly itemsPath: readonly (string | number)[];
			readonly pagination:
				| { readonly kind: "single-page" }
				| {
						readonly kind: "has-next";
						readonly path: readonly (string | number)[];
				  };
	  };

export interface ProofInput {
	readonly expectedOwner: string;
	/** Installs response capture first, then invokes this action. It must load the requested surface. */
	readonly navigate: () => Promise<unknown>;
	readonly page: Page;
	readonly surface: SurfaceBinding;
}

export type ProofResult =
	| {
			readonly proven: true;
			readonly evidence: {
				readonly source: "dom" | "network";
				readonly status: number;
				readonly url: string;
			};
	  }
	| { readonly proven: false; readonly reason: string };

const SETTLE_MS = 2500;
const POLL_MS = 100;
const TIMEOUT_MS = 4000;
const fail = (reason: string): ProofResult => ({ proven: false, reason });

function matches(pattern: RegExp, value: string): boolean {
	pattern.lastIndex = 0;
	return pattern.test(value);
}

function atPath(value: unknown, path: readonly (string | number)[]): unknown {
	let current = value;
	for (const key of path) {
		if (current === null || typeof current !== "object") {
			return undefined;
		}
		current = Reflect.get(current, key);
	}
	return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasEnvelopeError(body: unknown): boolean {
	if (!isRecord(body)) return true;
	const pending: unknown[] = [body];
	while (pending.length > 0) {
		const value = pending.pop();
		if (Array.isArray(value)) {
			pending.push(...value);
		} else if (isRecord(value)) {
			if (
				value.error !== undefined ||
				value.errors !== undefined ||
				value.challenge !== undefined ||
				value.captcha !== undefined ||
				value.authenticated === false ||
				value.success === false ||
				value.loading === true ||
				value.status === "error" ||
				value.status === "loading"
			)
				return true;
			pending.push(...Object.values(value));
		}
	}
	return false;
}

function requestOperation(response: Response): string | null {
	try {
		const body: unknown = response.request().postDataJSON();
		return isRecord(body) && typeof body.operationName === "string"
			? body.operationName
			: null;
	} catch {
		return null;
	}
}

interface Capture {
	readonly navigation: Response;
	readonly target: Response | null;
}

async function capture(input: ProofInput): Promise<Capture | null> {
	const responses: Response[] = [];
	const onResponse = (response: Response) => responses.push(response);
	input.page.on("response", onResponse);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			input.navigate(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("proof navigation timed out")),
					TIMEOUT_MS,
				);
			}),
		]);
	} catch {
		return null;
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
		input.page.off("response", onResponse);
	}
	const navigation = responses.filter(
		(response) =>
			response.request().isNavigationRequest() &&
			matches(input.surface.pageUrl, response.url()),
	);
	if (
		navigation.length !== 1 ||
		!navigation[0]?.ok() ||
		!matches(input.surface.pageUrl, input.page.url())
	) {
		return null;
	}
	if (input.surface.kind === "dom") {
		return { navigation: navigation[0], target: null };
	}
	const { surface } = input;
	const targets = responses.filter(
		(response) =>
			matches(surface.responseUrl, response.url()) &&
			(surface.operationName === undefined ||
				requestOperation(response) === surface.operationName),
	);
	if (
		targets.length !== 1 ||
		!targets[0]?.ok() ||
		responses.indexOf(targets[0]) <= responses.indexOf(navigation[0])
	) {
		return null;
	}
	return { navigation: navigation[0], target: targets[0] };
}

interface DomSnapshot {
	readonly blocked: boolean;
	readonly visibleBlocker: boolean;
	readonly textBlocker: boolean;
	readonly paginationPending: boolean;
	readonly containerCount: number;
	readonly empty: boolean;
	readonly owner: string | null;
	readonly signature: string;
}

function isBlocked(snapshot: DomSnapshot): boolean {
	return snapshot.blocked || snapshot.visibleBlocker || snapshot.textBlocker;
}

function isPaginationPending(
	snapshot: DomSnapshot,
	jsonContinuationPending = false,
): boolean {
	return snapshot.paginationPending || jsonContinuationPending;
}

// Keep the browser evaluator as source text: tsx wraps nested functions with a
// Node-only helper that is unavailable inside Playwright's isolated world.
const DOM_EVALUATOR = String.raw`({ binding, requireEmpty }) => {
	const visible = (element) => {
		for (let node = element; node; node = node.parentElement) {
			const style = getComputedStyle(node);
			if (node.getAttribute("aria-hidden") === "true" || node.hasAttribute("inert") ||
				style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) return false;
		}
		const boxes = [...element.getClientRects()];
		const range = document.createRange();
		range.selectNodeContents(element);
		boxes.push(...range.getClientRects());
		return boxes.some((box) => box.width > 0 && box.height > 0 && box.right > 0 && box.bottom > 0 &&
			box.left < innerWidth && box.top < innerHeight);
	};
	const renderedText = (element) => {
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		const parts = [];
		while (walker.nextNode()) {
			const node = walker.currentNode;
			const parent = node.parentElement;
			if (parent && visible(parent)) parts.push(node.textContent ?? "");
		}
		return parts.join(" ").replace(/\s+/g, " ").trim();
	};
	const candidates = binding ? [...document.querySelectorAll(binding.containerSelector)].filter(visible) : [];
	const container = candidates.length === 1 ? candidates[0] : null;
	const owners = binding ? [...document.querySelectorAll(binding.ownerSelector)].filter(visible) : [];
	const owner = owners.length === 1 && owners[0] ? renderedText(owners[0]) : null;
	const visibleBlocker = [...document.querySelectorAll(
		'[role="alert"], [role="progressbar"], [aria-busy="true"], input[type="password"], [class*="captcha" i], [id*="captcha" i], [class*="challenge" i], [data-sitekey]',
	)].some(visible);
	const paginationPending = [...document.querySelectorAll('a[rel="next"], [aria-label*="next page" i]')].some(visible);
	const pageText = renderedText(document.body);
	const textBlocker = /\b(sign in|log in|captcha|verify you are human|verify your identity|not a bot|robot check|security check|something went wrong|could not be loaded|access denied|unauthorized|forbidden|try again later|temporarily unavailable|loading|error)\b/i.test(pageText);
	const items = container && binding ? [...container.querySelectorAll(binding.itemSelector)] : [];
	const markers = container && binding ? [...container.querySelectorAll(binding.emptySelector)].filter(visible) : [];
	const empty = Boolean(binding && markers.length === 1 && markers[0] && renderedText(markers[0]) === binding.emptyText);
	return {
		owner,
		empty,
		visibleBlocker,
		textBlocker,
		paginationPending,
		containerCount: candidates.length,
		blocked: document.readyState !== "complete" || (binding !== null && candidates.length !== 1) || visibleBlocker || textBlocker || (requireEmpty && items.length > 0),
		signature: pageText + "|" + items.length + "|" + markers.length,
	};
}`;

function readDom(
	page: Page,
	surface: Extract<SurfaceBinding, { kind: "dom" }>,
	emptyRequired: boolean,
): Promise<DomSnapshot> {
	const argument = JSON.stringify({
		binding: surface,
		requireEmpty: emptyRequired,
	});
	return page.evaluate<DomSnapshot>(`(${DOM_EVALUATOR})(${argument})`);
}

function readPageGuard(page: Page): Promise<DomSnapshot> {
	return page.evaluate<DomSnapshot>(
		`(${DOM_EVALUATOR})(${JSON.stringify({ binding: null, requireEmpty: false })})`,
	);
}

async function proveDom(
	input: ProofInput,
	emptyRequired: boolean,
	captureResult: Capture,
): Promise<ProofResult> {
	if (input.surface.kind !== "dom") {
		return fail("surface_kind_mismatch");
	}
	const start = Date.now();
	let settledSince: number | null = null;
	let previousSignature: string | null = null;
	while (Date.now() - start < TIMEOUT_MS) {
		const snapshot = await readDom(input.page, input.surface, emptyRequired);
		if (
			isBlocked(snapshot) ||
			isPaginationPending(snapshot) ||
			snapshot.containerCount !== 1 ||
			snapshot.owner !== input.expectedOwner ||
			(emptyRequired && !snapshot.empty)
		) {
			return fail("dom_evidence_missing_or_conflicting");
		}
		if (snapshot.signature !== previousSignature) {
			settledSince = Date.now();
		}
		previousSignature = snapshot.signature;
		if (settledSince !== null && Date.now() - settledSince >= SETTLE_MS) {
			return {
				proven: true,
				evidence: {
					source: "dom",
					status: captureResult.navigation.status(),
					url: captureResult.navigation.url(),
				},
			};
		}
		await input.page.waitForTimeout(POLL_MS);
	}
	return fail("surface_timeout");
}

async function proveNetwork(
	input: ProofInput,
	emptyRequired: boolean,
	captureResult: Capture,
): Promise<ProofResult> {
	if (input.surface.kind !== "network" || !captureResult.target) {
		return fail("surface_response_missing");
	}
	const pageGuard = await readPageGuard(input.page);
	if (isBlocked(pageGuard)) {
		return fail("page_error_or_challenge");
	}
	const body: unknown = await captureResult.target.json();
	if (hasEnvelopeError(body)) {
		return fail("response_error_or_challenge");
	}
	if (atPath(body, input.surface.ownerPath) !== input.expectedOwner) {
		return fail("owner_mismatch");
	}
	if (emptyRequired) {
		const items = atPath(body, input.surface.itemsPath);
		if (!Array.isArray(items) || items.length !== 0) {
			return fail("items_not_explicitly_empty");
		}
		const jsonContinuationPending =
			input.surface.pagination.kind === "has-next" &&
			atPath(body, input.surface.pagination.path) !== false;
		if (isPaginationPending(pageGuard, jsonContinuationPending)) {
			return fail("pagination_not_terminal");
		}
	}
	return {
		proven: true,
		evidence: {
			source: "network",
			status: captureResult.target.status(),
			url: captureResult.target.url(),
		},
	};
}

async function prove(
	input: ProofInput,
	emptyRequired: boolean,
): Promise<ProofResult> {
	if (!input.expectedOwner?.trim()) {
		return fail("expected_owner_missing");
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			(async () => {
				const result = await capture(input);
				if (!result) return fail("successful_surface_load_missing");
				return input.surface.kind === "dom"
					? await proveDom(input, emptyRequired, result)
					: await proveNetwork(input, emptyRequired, result);
			})(),
			new Promise<ProofResult>((resolve) => {
				timer = setTimeout(
					() => resolve(fail("surface_timeout")),
					TIMEOUT_MS * 2,
				);
			}),
		]);
	} catch {
		return fail("evidence_unreadable");
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Proves a terminal empty result only from owner-bound, successful surface evidence. */
export function proveEmpty(input: ProofInput): Promise<ProofResult> {
	return prove(input, true);
}

/** Proves the requested owner on a successful surface without claiming emptiness. */
export function proveIdentity(input: ProofInput): Promise<ProofResult> {
	return prove(input, false);
}
