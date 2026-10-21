// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
	type CoverageClaim,
	type EndFacts,
	type ListRead,
	type ListStop,
	publicDiagnostics,
	type Settlement,
	settle,
} from "./list-exhaustion.ts";

const TERMINAL: EndFacts = {
	rule: "provider_terminal",
	signal: "cursor_null",
	schemaKnown: true,
	dataReadable: true,
	pageRowsSeen: 10,
	pageRowsParsed: 10,
};

interface Overrides {
	requested?: ListRead<unknown>["requested"];
	traversal?: Partial<ListRead<unknown>["traversal"]>;
	accounting?: Partial<ListRead<unknown>["accounting"]>;
	stop?: ListStop;
}

/** A clean three-page walk from the source start ending on a provider terminal. */
function read(over: Overrides = {}): ListRead<unknown> {
	return {
		items: [],
		requested: over.requested ?? "inventory",
		traversal: {
			startBoundary: "source_start",
			ordering: "none",
			pagesRead: 3,
			pagesGapped: 0,
			pagesSkippedUnaccounted: 0,
			synthesizedSuccessors: 0,
			epochChanges: 0,
			...over.traversal,
		},
		accounting: {
			rawItems: 30,
			distinctKeys: 30,
			duplicateItems: 0,
			gappedItems: 0,
			unaccountedItems: 0,
			...over.accounting,
		},
		stop: over.stop ?? { kind: "end", end: TERMINAL },
	};
}

const end = (facts: EndFacts): ListStop => ({ kind: "end", end: facts });

/** For malformed-input cases: the caller can pass anything at runtime. */
const asRead = (value: unknown): ListRead<unknown> =>
	value as ListRead<unknown>;
const asEnd = (value: unknown): EndFacts => value as EndFacts;

function check(
	claim: CoverageClaim,
	input: ListRead<unknown>,
	outcome: Settlement["outcome"],
	reason?: Settlement["reason"],
): void {
	const got = settle(claim, input);
	assert.equal(got.outcome, outcome, `outcome (reason ${got.reason})`);
	assert.equal(got.reason, reason, "reason");
	assert.equal(got.claim, claim);
}

test("a contiguous walk from the source start with an explicit terminal is complete", () => {
	check("full_inventory", read(), "complete");
});

test("a first page with more data behind it is never complete", () => {
	check(
		"full_inventory",
		read({
			traversal: { pagesRead: 1 },
			accounting: { rawItems: 10, distinctKeys: 10 },
			stop: { kind: "budget", limit: "pages", resumable: true },
		}),
		"partial",
		"budget_pages",
	);
	check(
		"full_inventory",
		read({ stop: { kind: "no_end_signal" } }),
		"unproven",
		"no_end_signal",
	);
});

test("a skipped middle page does not hide behind a valid terminal on the last page", () => {
	check(
		"full_inventory",
		read({ traversal: { pagesSkippedUnaccounted: 1 } }),
		"unproven",
		"chain_unproven",
	);
	check(
		"full_inventory",
		read({ traversal: { synthesizedSuccessors: 1 } }),
		"unproven",
		"chain_unproven",
	);
	check(
		"full_inventory",
		read({ traversal: { epochChanges: 1 } }),
		"unproven",
		"epoch_changed",
	);
	// Counter-example: a page that was not read but is durably accounted for.
	check(
		"full_inventory",
		read({
			traversal: { pagesGapped: 1 },
			accounting: { gappedItems: 10 },
		}),
		"complete",
	);
});

test("earlier discards are not hidden by a clean last page", () => {
	check(
		"full_inventory",
		read({ accounting: { unaccountedItems: 2 } }),
		"unproven",
		"rows_unaccounted",
	);
});

test("an unknown start boundary is not an inventory", () => {
	check(
		"full_inventory",
		read({ traversal: { startBoundary: "unknown" } }),
		"unproven",
		"start_unknown",
	);
});

test("a resumed walk needs a named guarantee; an anchor hit is not one", () => {
	check(
		"full_inventory",
		read({
			traversal: { startBoundary: "validated_resume", ordering: "none" },
		}),
		"unproven",
		"resume_unguaranteed",
	);
	check(
		"full_inventory",
		read({
			traversal: { startBoundary: "validated_resume", ordering: "snapshot" },
		}),
		"complete",
	);
});

test("duplicates are counted, not mistaken for distinct identities", () => {
	const declared = (total: number): ListStop =>
		end({
			rule: "declared_total",
			declaredTotal: total,
			continuationVisible: false,
		});
	// 3 raw rows but only 2 distinct identities: a declared total of 3 is not met.
	check(
		"full_inventory",
		read({
			accounting: { rawItems: 3, distinctKeys: 2, duplicateItems: 1 },
			stop: declared(3),
		}),
		"unproven",
		"count_mismatch",
	);
	check(
		"full_inventory",
		read({
			accounting: { rawItems: 4, distinctKeys: 3, duplicateItems: 1 },
			stop: declared(3),
		}),
		"complete",
	);
	// accounting arithmetic that does not add up is invalid, not trusted
	check(
		"full_inventory",
		read({ accounting: { rawItems: 4, distinctKeys: 3, duplicateItems: 0 } }),
		"unproven",
		"invalid_facts",
	);
});

test("old pages under an unstable ordering are not an inventory end or a window end", () => {
	const old = end({
		rule: "window_boundary",
		intervalBounded: true,
		ordering: "stable_order",
		oldPagesInARow: 3,
		required: 3,
	});
	for (const claim of ["full_inventory", "checkpoint_window"] as const) {
		check(
			claim,
			read({ requested: "window", traversal: { ordering: "none" }, stop: old }),
			"unproven",
			"ordering_unguaranteed",
		);
	}
	// facts that name a different ordering than the walk declared disagree
	check(
		"checkpoint_window",
		read({
			requested: "window",
			traversal: { ordering: "snapshot" },
			stop: old,
		}),
		"unproven",
		"ordering_unguaranteed",
	);
});

test("a guaranteed window ends a window claim, never an inventory claim", () => {
	const old = (oldPagesInARow: number): ListStop =>
		end({
			rule: "window_boundary",
			intervalBounded: true,
			ordering: "stable_order",
			oldPagesInARow,
			required: 3,
		});
	const windowRead = (stop: ListStop, requested: "window" | "inventory") =>
		read({ requested, traversal: { ordering: "stable_order" }, stop });
	check("checkpoint_window", windowRead(old(3), "window"), "window_complete");
	check(
		"full_inventory",
		windowRead(old(3), "window"),
		"partial",
		"window_only",
	);
	// fewer old pages than required is contradictory facts, not a window end
	check(
		"checkpoint_window",
		windowRead(old(2), "window"),
		"unproven",
		"invalid_facts",
	);
	// a window claim over an unscoped request does not borrow the window rule
	check(
		"checkpoint_window",
		windowRead(old(3), "inventory"),
		"unproven",
		"scope_mismatch",
	);
	// a chain break still blocks a window claim
	check(
		"checkpoint_window",
		read({
			requested: "window",
			traversal: { ordering: "stable_order", pagesSkippedUnaccounted: 1 },
			stop: old(3),
		}),
		"unproven",
		"chain_unproven",
	);
});

test("bounded and window-scoped ends never become an inventory or a global empty", () => {
	const bounded = end({
		rule: "bounded_request",
		bound: "owner_item_limit",
		reached: true,
	});
	check(
		"full_inventory",
		read({ requested: "bounded", stop: bounded }),
		"partial",
		"bounded_only",
	);
	check(
		"checkpoint_window",
		read({ requested: "bounded", stop: bounded }),
		"bounded_complete",
	);
	// the request was a limit/filter; a terminal on it is not an inventory end
	check(
		"full_inventory",
		read({ requested: "bounded" }),
		"partial",
		"bounded_only",
	);
	check(
		"full_inventory",
		read({ requested: "window" }),
		"partial",
		"window_only",
	);

	const empty = end({
		rule: "source_empty",
		dataReadable: true,
		sourceSaidEmpty: true,
	});
	const emptyRead = (over: Overrides) =>
		read({
			traversal: { pagesRead: 1 },
			accounting: { rawItems: 0, distinctKeys: 0 },
			stop: empty,
			...over,
		});
	check("full_inventory", emptyRead({}), "verified_empty");
	check(
		"full_inventory",
		emptyRead({ requested: "bounded" }),
		"partial",
		"bounded_only",
	);
	check(
		"full_inventory",
		emptyRead({ requested: "window" }),
		"partial",
		"window_only",
	);
	// an empty read from an unknown start is not an empty source
	check(
		"full_inventory",
		emptyRead({ traversal: { startBoundary: "unknown", pagesRead: 1 } }),
		"unproven",
		"start_unknown",
	);
	// the source said empty but rows were read: contradiction
	check(
		"full_inventory",
		emptyRead({ accounting: { rawItems: 2, distinctKeys: 2 } }),
		"unproven",
		"count_mismatch",
	);
});

test("budgets, stalls and unreadable pages are not completions", () => {
	for (const limit of ["pages", "items", "rounds", "time"] as const) {
		check(
			"full_inventory",
			read({ stop: { kind: "budget", limit, resumable: false } }),
			"partial",
			`budget_${limit}`,
		);
	}
	assert.equal(
		settle(
			"full_inventory",
			read({ stop: { kind: "budget", limit: "items", resumable: true } }),
		).resumable,
		true,
	);
	check(
		"full_inventory",
		read({ stop: { kind: "stalled", reason: "no_progress" } }),
		"stalled",
		"no_progress",
	);
	check(
		"full_inventory",
		read({ stop: { kind: "stalled", reason: "cursor_cycle" } }),
		"stalled",
		"cursor_cycle",
	);
	for (const reason of [
		"page",
		"response",
		"auth",
		"parse_mismatch",
	] as const) {
		check(
			"full_inventory",
			read({ stop: { kind: "unreadable", reason } }),
			"unreadable",
			reason,
		);
	}
});

test("provider_terminal needs an explicit recognised signal and fully parsed rows", () => {
	check(
		"full_inventory",
		read({ stop: end({ ...TERMINAL, pageRowsParsed: 9 } as EndFacts) }),
		"unproven",
		"parse_mismatch",
	);
	for (const mutate of [
		{ schemaKnown: false },
		{ dataReadable: false },
		{ signal: "missing" },
		{ signal: undefined },
	]) {
		check(
			"full_inventory",
			read({ stop: end(asEnd({ ...TERMINAL, ...mutate })) }),
			"unproven",
			"invalid_facts",
		);
	}
	const { signal: _signal, ...noSignal } = TERMINAL as Extract<
		EndFacts,
		{ rule: "provider_terminal" }
	>;
	check(
		"full_inventory",
		read({ stop: end(asEnd(noSignal)) }),
		"unproven",
		"invalid_facts",
	);
});

test("continuation and end-marker ends reconcile with counts and reject DOM recycling", () => {
	const consumed = (over: Record<string, unknown> = {}): ListStop =>
		end({
			rule: "continuation_consumed",
			dataReadable: true,
			continuationSeenBefore: true,
			continuationVisible: false,
			renderedAtEnd: 30,
			sourceItemsAtEnd: null,
			...over,
		} as EndFacts);
	const marker = (over: Record<string, unknown> = {}): ListStop =>
		end({
			rule: "source_end_marker",
			dataReadable: true,
			markerPresent: true,
			continuationVisible: false,
			renderedAtEnd: 30,
			sourceItemsAtEnd: 30,
			...over,
		} as EndFacts);
	check("full_inventory", read({ stop: consumed() }), "complete");
	check("full_inventory", read({ stop: marker() }), "complete");
	// rendered DOM holds fewer rows than were seen: recycled, not proof of the whole list
	check(
		"full_inventory",
		read({ stop: consumed({ renderedAtEnd: 12 }) }),
		"unproven",
		"count_mismatch",
	);
	check(
		"full_inventory",
		read({ stop: marker({ renderedAtEnd: 12, sourceItemsAtEnd: 12 }) }),
		"unproven",
		"count_mismatch",
	);
	// the source reports more items than were rendered
	check(
		"full_inventory",
		read({ stop: marker({ sourceItemsAtEnd: 45 }) }),
		"unproven",
		"count_mismatch",
	);
	// a visible continuation contradicts the end
	check(
		"full_inventory",
		read({ stop: consumed({ continuationVisible: true }) }),
		"unproven",
		"invalid_facts",
	);
	check(
		"full_inventory",
		read({ stop: marker({ dataReadable: false }) }),
		"unproven",
		"invalid_facts",
	);
	check(
		"full_inventory",
		read({ stop: marker({ markerPresent: false }) }),
		"unproven",
		"invalid_facts",
	);
	// chain rules still need the traversal record
	check(
		"full_inventory",
		read({ stop: marker(), traversal: { startBoundary: "unknown" } }),
		"unproven",
		"start_unknown",
	);
});

test("declared_total must equal distinct identities and be a count", () => {
	const declared = (
		declaredTotal: unknown,
		over: Record<string, unknown> = {},
	): ListStop =>
		end({
			rule: "declared_total",
			declaredTotal,
			continuationVisible: false,
			...over,
		} as EndFacts);
	check("full_inventory", read({ stop: declared(30) }), "complete");
	check(
		"full_inventory",
		read({ stop: declared(31) }),
		"unproven",
		"count_mismatch",
	);
	for (const bad of [
		30.5,
		-1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		"30",
		null,
	]) {
		check(
			"full_inventory",
			read({ stop: declared(bad) }),
			"unproven",
			"invalid_facts",
		);
	}
	check(
		"full_inventory",
		read({ stop: declared(30, { continuationVisible: true }) }),
		"unproven",
		"invalid_facts",
	);
});

test("bare booleans, unknown rules, unknown keys and malformed shapes are unproven", () => {
	const unknownKey = { ...read(), extra: true };
	const cases: unknown[] = [
		null,
		undefined,
		"complete",
		[],
		{},
		{ ...read(), stop: { exhausted: true } },
		{ ...read(), stop: { kind: "end", end: { exhausted: true } } },
		{ ...read(), stop: { kind: "end", end: { rule: "trust_me" } } },
		{ ...read(), stop: { kind: "end", end: { ...TERMINAL, extra: 1 } } },
		{ ...read(), stop: { kind: "end" } },
		{ ...read(), stop: { kind: "budget", limit: "pages" } },
		{ ...read(), stop: { kind: "budget", limit: "bytes", resumable: true } },
		{ ...read(), stop: { kind: "budget", limit: "pages", resumable: "yes" } },
		{ ...read(), stop: { kind: "stalled", reason: "bored" } },
		{ ...read(), stop: { kind: "unreadable", reason: "tuesday" } },
		{ ...read(), stop: { kind: "no_end_signal", extra: 1 } },
		{ ...read(), requested: "everything" },
		{ ...read(), items: "rows" },
		{ ...read(), traversal: undefined },
		{ ...read(), traversal: { ...read().traversal, pagesRead: -1 } },
		{ ...read(), traversal: { ...read().traversal, pagesRead: 1.5 } },
		{ ...read(), traversal: { ...read().traversal, epochChanges: Number.NaN } },
		{ ...read(), traversal: { ...read().traversal, startBoundary: "start" } },
		{ ...read(), traversal: { ...read().traversal, ordering: "mostly" } },
		{ ...read(), traversal: { ...read().traversal, pagesRead: 0 } },
		{ ...read(), accounting: { ...read().accounting, rawItems: "30" } },
		{ ...read(), accounting: { ...read().accounting, gappedItems: 40 } },
		unknownKey,
	];
	for (const input of cases) {
		const got = settle("full_inventory", asRead(input));
		assert.equal(got.outcome, "unproven", JSON.stringify(input));
		assert.ok(got.reason);
	}
	const { stop: _stop, ...missingStop } = read();
	check("full_inventory", asRead(missingStop), "unproven", "invalid_facts");
	const invalidClaim = settle("everything" as CoverageClaim, read());
	assert.equal(invalidClaim.outcome, "unproven");
	assert.equal(invalidClaim.reason, "invalid_claim");
	assert.equal(invalidClaim.claim, "full_inventory");
});

test("a throwing getter yields unproven instead of an exception", () => {
	const hostile = {
		...read(),
		get requested(): never {
			throw new Error("secret-canary-getter");
		},
	};
	const got = settle("full_inventory", asRead(hostile));
	assert.equal(got.outcome, "unproven");
	assert.equal(got.reason, "invalid_facts");
	assert.ok(!JSON.stringify(got).includes("secret-canary-getter"));
});

test("settle is pure: same facts, same result, input untouched, result frozen", () => {
	const input = read();
	const before = JSON.stringify(input);
	const a = settle("full_inventory", input);
	const b = settle("full_inventory", input);
	assert.deepEqual(a, b);
	assert.equal(JSON.stringify(input), before);
	assert.ok(Object.isFrozen(a));
});

test("output never carries item, key, cursor or caller-string content", () => {
	const canary = "CANARY-private-value";
	const withItems: ListRead<unknown> = {
		...read({ traversal: { pagesSkippedUnaccounted: 1 } }),
		items: [{ id: canary, url: `https://example.test/${canary}` }],
	};
	const hostile = {
		...read(),
		cursor: canary,
		stop: { kind: "end", end: { ...TERMINAL, note: canary } },
	};
	for (const input of [withItems, asRead(hostile), read()]) {
		const s = settle("full_inventory", input);
		const d = publicDiagnostics(s, input);
		assert.ok(!JSON.stringify(s).includes(canary));
		assert.ok(!JSON.stringify(d).includes(canary));
	}
	const d = publicDiagnostics(settle("full_inventory", read()), read());
	assert.deepEqual(Object.keys(d).sort(), [
		"claim",
		"distinctKeys",
		"duplicateItems",
		"gappedItems",
		"outcome",
		"pagesRead",
		"rawItems",
		"rule",
		"unaccountedItems",
	]);
	assert.equal(d.rule, "provider_terminal");
	assert.equal(d.rawItems, 30);
	// hostile counts are not echoed; invalid numbers become 0
	const bad = asRead({
		...read(),
		accounting: { rawItems: canary },
		traversal: { pagesRead: 1.5 },
		stop: { kind: "end", end: { rule: canary } },
	});
	const bd = publicDiagnostics(settle("full_inventory", bad), bad);
	assert.equal(bd.rawItems, 0);
	assert.equal(bd.pagesRead, 0);
	assert.equal(bd.rule, undefined);
});

// Regressions from the independent review of f095c05. Each fixture is valid
// except for one cross-field contradiction.

test("declared_total does not bypass the epoch check", () => {
	// 15 rows from one filter/source epoch and 15 from another can sum to the
	// declared total without the total covering either epoch.
	check(
		"full_inventory",
		read({
			traversal: { epochChanges: 1 },
			stop: end({
				rule: "declared_total",
				declaredTotal: 30,
				continuationVisible: false,
			}),
		}),
		"unproven",
		"epoch_changed",
	);
});

test("end facts that contradict the cumulative counts or the page count are unproven", () => {
	// The last page cannot have parsed more rows than the whole walk read.
	check(
		"full_inventory",
		read({ accounting: { rawItems: 0, distinctKeys: 0 } }),
		"unproven",
		"count_mismatch",
	);
	check(
		"full_inventory",
		read({
			accounting: { rawItems: 9, distinctKeys: 9 },
			stop: end({ ...(TERMINAL as object), pageRowsSeen: 10 } as EndFacts),
		}),
		"unproven",
		"count_mismatch",
	);
	// One page cannot attest three consecutive old pages.
	check(
		"checkpoint_window",
		read({
			requested: "window",
			traversal: { ordering: "stable_order", pagesRead: 1 },
			stop: end({
				rule: "window_boundary",
				intervalBounded: true,
				ordering: "stable_order",
				oldPagesInARow: 3,
				required: 3,
			}),
		}),
		"unproven",
		"count_mismatch",
	);
});

test("only own keys on plain objects count; inherited, hidden and symbol keys are rejected", () => {
	const proto = (inherited: object, own: object): object =>
		Object.assign(Object.create(inherited), own);
	const valid = read();
	const cases: unknown[] = [
		// required `kind` inherited, unknown own key takes its place in the count
		{ ...valid, stop: proto({ kind: "end" }, { end: TERMINAL, extra: true }) },
		// required `kind` only inherited
		{ ...valid, stop: proto({ kind: "end" }, { end: TERMINAL }) },
		// unknown own key that is not enumerable
		{
			...valid,
			stop: Object.defineProperty({ kind: "end", end: TERMINAL }, "hidden", {
				value: 1,
				enumerable: false,
			}),
		},
		// unknown symbol-keyed own property
		{ ...valid, stop: { kind: "end", end: TERMINAL, [Symbol("x")]: 1 } },
		// non-plain prototypes at each level
		{
			...valid,
			stop: new (class Stop {
				kind = "end";
				end = TERMINAL;
			})(),
		},
		{ ...valid, traversal: proto({}, valid.traversal) },
		{ ...valid, accounting: proto({}, valid.accounting) },
		{ ...valid, stop: { kind: "end", end: proto({}, TERMINAL) } },
		proto({}, valid),
	];
	for (const input of cases) {
		check("full_inventory", asRead(input), "unproven", "invalid_facts");
	}
	// counter-example: a null-prototype object with exactly the own keys is fine
	const plain = Object.assign(Object.create(null), {
		kind: "end",
		end: TERMINAL,
	});
	check("full_inventory", read({ stop: plain }), "complete");
});

test("every count field rejects nonfinite, unsafe, negative and fractional numbers", () => {
	const fixtures = [
		read(),
		read({
			stop: end({
				rule: "declared_total",
				declaredTotal: 30,
				continuationVisible: false,
			}),
		}),
		read({
			stop: end({
				rule: "continuation_consumed",
				dataReadable: true,
				continuationSeenBefore: true,
				continuationVisible: false,
				renderedAtEnd: 30,
				sourceItemsAtEnd: 30,
			}),
		}),
		read({
			stop: end({
				rule: "source_end_marker",
				dataReadable: true,
				markerPresent: true,
				continuationVisible: false,
				renderedAtEnd: 30,
				sourceItemsAtEnd: 30,
			}),
		}),
		read({
			requested: "window",
			traversal: { ordering: "snapshot" },
			stop: end({
				rule: "window_boundary",
				intervalBounded: true,
				ordering: "snapshot",
				oldPagesInARow: 3,
				required: 3,
			}),
		}),
	];
	for (const [index, fixture] of fixtures.entries()) {
		const claim = index === 4 ? "checkpoint_window" : "full_inventory";
		check(claim, fixture, index === 4 ? "window_complete" : "complete");
		// Traversal/accounting are shared shapes; exercise them only once.
		const records =
			index === 0
				? (["traversal", "accounting", "end"] as const)
				: (["end"] as const);
		for (const section of records) {
			const source =
				section === "end"
					? (fixture.stop as Extract<ListStop, { kind: "end" }>).end
					: fixture[section];
			for (const [key, value] of Object.entries(source)) {
				if (typeof value !== "number") continue;
				for (const bad of [
					Number.NaN,
					Infinity,
					-Infinity,
					Number.MAX_SAFE_INTEGER + 1,
					-1,
					0.5,
				]) {
					const changed = { ...source, [key]: bad };
					const input =
						section === "end"
							? { ...fixture, stop: end(asEnd(changed)) }
							: { ...fixture, [section]: changed };
					assert.deepEqual(
						settle(claim, asRead(input)),
						{
							claim,
							outcome: "unproven",
							reason: "invalid_facts",
						},
						`${index}.${section}.${key}: ${bad}`,
					);
				}
			}
		}
	}
});

test("remaining end rules cannot hide a changed epoch or skipped middle page", () => {
	const fixtures: [CoverageClaim, ListRead<unknown>, Settlement["outcome"]][] =
		[
			[
				"full_inventory",
				read({
					stop: end({
						rule: "continuation_consumed",
						dataReadable: true,
						continuationSeenBefore: true,
						continuationVisible: false,
						renderedAtEnd: 30,
						sourceItemsAtEnd: null,
					}),
				}),
				"complete",
			],
			[
				"full_inventory",
				read({
					stop: end({
						rule: "source_end_marker",
						dataReadable: true,
						markerPresent: true,
						continuationVisible: false,
						renderedAtEnd: 30,
						sourceItemsAtEnd: 30,
					}),
				}),
				"complete",
			],
			[
				"full_inventory",
				read({
					accounting: { rawItems: 0, distinctKeys: 0 },
					stop: end({
						rule: "source_empty",
						dataReadable: true,
						sourceSaidEmpty: true,
					}),
				}),
				"verified_empty",
			],
			[
				"checkpoint_window",
				read({
					requested: "window",
					traversal: { ordering: "snapshot" },
					stop: end({
						rule: "window_boundary",
						intervalBounded: true,
						ordering: "snapshot",
						oldPagesInARow: 3,
						required: 3,
					}),
				}),
				"window_complete",
			],
			[
				"checkpoint_window",
				read({
					requested: "bounded",
					stop: end({
						rule: "bounded_request",
						bound: "resource_filter",
						reached: true,
					}),
				}),
				"bounded_complete",
			],
		];
	for (const [claim, fixture, outcome] of fixtures) {
		check(claim, fixture, outcome);
		for (const [key, reason] of [
			["epochChanges", "epoch_changed"],
			["pagesSkippedUnaccounted", "chain_unproven"],
		] as const) {
			check(
				claim,
				{ ...fixture, traversal: { ...fixture.traversal, [key]: 1 } },
				"unproven",
				reason,
			);
		}
	}
});

test("required keys at each data level cannot be supplied by a prototype", () => {
	const fixture = read();
	const records = [
		{ value: fixture, wrap: (value: object) => asRead(value) },
		{
			value: fixture.traversal,
			wrap: (value: object) => asRead({ ...fixture, traversal: value }),
		},
		{
			value: fixture.accounting,
			wrap: (value: object) => asRead({ ...fixture, accounting: value }),
		},
		{
			value: TERMINAL,
			wrap: (value: object) => read({ stop: end(asEnd(value)) }),
		},
	];
	for (const { value, wrap } of records) {
		// Positive control: the same own fields on a null prototype are valid.
		check(
			"full_inventory",
			wrap(Object.assign(Object.create(null), value)),
			"complete",
		);
		for (const [key, inherited] of Object.entries(value)) {
			const own: Record<string, unknown> = { ...value };
			delete own[key];
			check(
				"full_inventory",
				wrap(Object.assign(Object.create({ [key]: inherited }), own)),
				"unproven",
				"invalid_facts",
			);
			check(
				"full_inventory",
				wrap(Object.assign(Object.create(null), own)),
				"unproven",
				"invalid_facts",
			);
		}
	}
});

test("reflective traps return closed unproven results without exposing private payloads", () => {
	const canary = "PRIVATE-adversarial-cursor-key-row";
	const fail = (): never => {
		throw new Error(canary);
	};
	const revoked = Proxy.revocable(read(), {});
	revoked.revoke();
	const inputs = [
		revoked.proxy,
		new Proxy(read(), { getPrototypeOf: fail }),
		new Proxy(read(), { ownKeys: fail }),
		{ ...read(), traversal: new Proxy(read().traversal, { get: fail }) },
		{
			...read(),
			accounting: new Proxy(read().accounting, {
				getOwnPropertyDescriptor: fail,
			}),
		},
		read({ stop: end(new Proxy(TERMINAL, { get: fail })) }),
	];
	for (const input of inputs) {
		const got = settle("full_inventory", input);
		assert.deepEqual(got, {
			claim: "full_inventory",
			outcome: "unproven",
			reason: "invalid_facts",
		});
		assert.ok(Object.isFrozen(got));
		assert.ok(!JSON.stringify(got).includes(canary));
	}
	// Items are opaque payloads, not facts: even a throwing row is never read.
	const input = {
		...read(),
		items: [
			new Proxy(
				{ key: canary, cursor: canary, row: canary },
				{ get: fail, ownKeys: fail },
			),
		],
	};
	const got = settle("full_inventory", input);
	assert.equal(got.outcome, "complete");
	assert.ok(!JSON.stringify(publicDiagnostics(got, input)).includes(canary));
});
