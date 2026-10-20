// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for the fail-closed USAA export-dialog contract. No
 * scrubbed real provider DOM is available for this repair, so these tests use
 * a hermetic Playwright Page double and call driveExport; they exercise the
 * production parent path without claiming that the double proves the live
 * provider's selectors. No provider navigation or credentials are used.
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import type { BrowserContext, Page } from "playwright";
import {
	assertUserFacingProgress,
	setConnectorDiagnosticSink,
} from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import {
	driveExport,
	type EmitDeps,
	emitPdfStatementTransactions,
	processAccountTransactions,
	recoverServedAccountTransactionGaps,
	runSingleLadderAttempt,
	runTransactionsStream,
	tryExportLadder,
} from "./index.ts";

type FieldName = "start" | "end";

interface FieldState {
	editable?: boolean;
	enabled?: boolean;
	value?: string;
	visible?: boolean;
}

interface ExportPageShape {
	outcomeForStart?: (start: string) => "success" | "failure" | "empty";
	csvForStart?: (start: string) => string;
	detachField?: FieldName;
	dialog?: boolean;
	end?: FieldState;
	failField?: FieldName;
	select?: boolean;
	selectFails?: boolean;
	selectionRevealsDateFields?: boolean;
	start?: FieldState;
	unrelatedOutsideDialog?: boolean;
}

interface ExportPageProbe {
	events: () => string[];
	page: Page;
	submitCount: () => number;
	values: () => Record<FieldName, string>;
}

type Listener = (...args: unknown[]) => void;

const ACCOUNT_URL = "https://www.usaa.com/my/checking/fixture-account";

function makeResponse(csv?: string): Record<string, unknown> {
	return {
		body: async () =>
			Buffer.from(csv ?? "Date,Description,Amount\n01/02/2025,Fixture,1.00\n"),
		headers: () => ({
			"content-disposition": 'attachment; filename="fixture.csv"',
			"content-type": "text/csv",
		}),
		request: () => ({ method: () => "GET" }),
		status: () => 200,
		url: () => "https://www.usaa.com/fixture/export.csv",
	};
}

function makePage(shape: ExportPageShape): ExportPageProbe {
	let currentUrl = ACCOUNT_URL;
	let activeField: FieldName | null = null;
	let submitCount = 0;
	const events: string[] = [];
	const values: Record<FieldName, string> = {
		end: shape.end?.value ?? "",
		start: shape.start?.value ?? "",
	};
	const listeners = new Map<string, Set<Listener>>();

	const emit = (event: string, ...args: unknown[]): void => {
		for (const listener of listeners.get(event) ?? []) {
			listener(...args);
		}
	};

	const fieldState = (field: FieldName): FieldState | undefined =>
		field === "start" ? shape.start : shape.end;
	const scopedFieldState = (
		field: FieldName,
		scope: "page" | "dialog",
	): FieldState | undefined => {
		if (scope === "dialog") {
			return fieldState(field);
		}
		return (
			fieldState(field) ??
			(shape.unrelatedOutsideDialog
				? { editable: true, enabled: true, visible: true }
				: undefined)
		);
	};
	const fieldFromSelector = (selector: string): FieldName | null => {
		if (
			selector.includes('input[name="fromDate"]') ||
			selector.includes('input[name="startDate"]')
		) {
			return "start";
		}
		if (selector.includes('input[name="endDate"]')) {
			return "end";
		}
		return null;
	};

	const makeLocator = (
		selector: string,
		scope: "page" | "dialog" = "page",
	): Record<string, unknown> => {
		const locatorScope = selector.includes('[role="dialog"]')
			? "dialog"
			: scope;
		const field = fieldFromSelector(selector);
		const isDialog = selector === '[role="dialog"]';
		const isExport =
			selector.includes("ent-as-utility-bar__item.export") ||
			selector.includes('button, [role="button"]');
		const isSelect = selector.includes('select[name="selectionType"]');
		const isSubmit = selector.includes('button[type="submit"]');
		const isError =
			selector.includes("errorMessage") || selector.includes("no transactions");
		const isCancel = selector.includes("#export-cancel-button");
		const locator: Record<string, unknown> = {
			click: async (): Promise<void> => {
				await Promise.resolve();
				if (isExport) {
					events.push("export-click");
					return;
				}
				if (isSubmit) {
					submitCount += 1;
					events.push(`submit:${values.start}`);
					if (
						shape.outcomeForStart?.(values.start) &&
						shape.outcomeForStart(values.start) !== "success"
					)
						return;
					emit("response", makeResponse(shape.csvForStart?.(values.start)));
					emit("download", {});
					return;
				}
				if (isCancel) {
					return;
				}
				if (field) {
					if (shape.detachField === field) {
						throw new Error(`${field} field detached before fill`);
					}
					// Keep this later primitive permissive so the production
					// actionability gate is the only oracle for missing/hidden/disabled
					// fields. Detachment and explicit fill errors remain independent
					// failure paths below.
					activeField = field;
				}
			},
			count: async (): Promise<number> => {
				await Promise.resolve();
				if (isDialog) {
					return shape.dialog === false ? 0 : 1;
				}
				if (isExport) {
					return 1;
				}
				if (field) {
					if (locatorScope === "dialog") {
						return fieldState(field) ? 1 : 0;
					}
					return shape.unrelatedOutsideDialog ? 1 : 0;
				}
				if (isSelect) {
					return locatorScope === "dialog" && shape.select ? 1 : 0;
				}
				if (isSubmit || isError || isCancel) {
					return shape.dialog === false ? 0 : 1;
				}
				return 0;
			},
			filter: (): Record<string, unknown> => locator,
			first: (): Record<string, unknown> => locator,
			innerHTML: async (): Promise<string> =>
				'<div data-fixture="scrubbed-export-dialog"></div>',
			isEditable: (): Promise<boolean> => {
				const state = scopedFieldState(field as FieldName, locatorScope);
				return Promise.resolve(Boolean(state && state.editable !== false));
			},
			isEnabled: (): Promise<boolean> => {
				const state = scopedFieldState(field as FieldName, locatorScope);
				return Promise.resolve(Boolean(state && state.enabled !== false));
			},
			isVisible: (): Promise<boolean> => {
				const state = scopedFieldState(field as FieldName, locatorScope);
				return Promise.resolve(Boolean(state && state.visible !== false));
			},
			locator: (childSelector: string): Record<string, unknown> =>
				makeLocator(childSelector, "dialog"),
			pressSequentially: async (text: string): Promise<void> => {
				await Promise.resolve();
				if (!field || shape.failField === field) {
					throw new Error(`${field ?? "unknown"} field fill failed`);
				}
				values[field] += text;
			},
			selectOption: async (): Promise<string[]> => {
				await Promise.resolve();
				if (!(isSelect && shape.select)) {
					throw new Error("optional selection control is absent");
				}
				if (shape.selectFails) {
					throw new Error("selection control rejected date-range");
				}
				events.push("select-date-range");
				if (shape.selectionRevealsDateFields) {
					shape.start = { editable: true, enabled: true, visible: true };
					shape.end = { editable: true, enabled: true, visible: true };
				}
				return ["date-range"];
			},
			textContent: async (): Promise<string | null> =>
				isError && shape.outcomeForStart
					? shape.outcomeForStart(values.start) === "empty"
						? "No transactions to export"
						: "Please try again later"
					: null,
			waitFor: async ({ state }: { state: string }): Promise<void> => {
				await Promise.resolve();
				if (
					state === "visible" &&
					isError &&
					(!shape.outcomeForStart ||
						shape.outcomeForStart(values.start) === "success")
				) {
					throw new Error("no dialog error is present");
				}
				if (state === "visible" && isDialog && shape.dialog === false) {
					throw new Error("dialog is absent");
				}
				if (state === "visible" && isSelect && !shape.select) {
					throw new Error("selection control is absent");
				}
				if (state === "visible" && field) {
					events.push(`check-actionability:${field}`);
					const fieldDetails = scopedFieldState(field, locatorScope);
					if (
						!(
							fieldDetails &&
							locatorScope === "dialog" &&
							fieldDetails.visible !== false &&
							fieldDetails.enabled !== false &&
							fieldDetails.editable !== false
						)
					) {
						throw new Error(`${field} field is not visible and actionable`);
					}
				}
			},
		};
		return locator;
	};

	const page = Object.assign({} as Page, {
		context: () => ({
			newCDPSession: () =>
				Promise.reject(new Error("fixture has no CDP session")),
		}),
		keyboard: {
			press: async (key: string): Promise<void> => {
				await Promise.resolve();
				if (activeField && (key === "Control+A" || key === "Delete")) {
					values[activeField] = "";
				}
			},
		},
		locator: (selector: string): Record<string, unknown> =>
			makeLocator(selector),
		off: (event: string, listener: Listener): void => {
			listeners.get(event)?.delete(listener);
		},
		on: (event: string, listener: Listener): void => {
			const eventListeners = listeners.get(event) ?? new Set<Listener>();
			eventListeners.add(listener);
			listeners.set(event, eventListeners);
		},
		selectOption: (): Promise<string[]> => Promise.resolve(["date-range"]),
		url: (): string => currentUrl,
		evaluate: (): Promise<null> => Promise.resolve(null),
		goto: async (url: string): Promise<null> => {
			await Promise.resolve();
			currentUrl = url;
			return null;
		},
	});

	return {
		page,
		submitCount: () => submitCount,
		events: () => [...events],
		values: () => ({ ...values }),
	};
}

function options() {
	return {
		settleDelayMs: 0,
		sinceDate: "2025-01-02",
		untilDate: "2025-01-31",
	};
}

async function assertRejectedBeforeSubmit(
	shape: ExportPageShape,
): Promise<void> {
	const probe = makePage(shape);
	const result = await driveExport(probe.page, ACCOUNT_URL, options());
	assert.deepEqual(result, { kind: "failed" });
	assert.equal(
		probe.submitCount(),
		0,
		"invalid dialog shape must fail before submit",
	);
}

test("production fallback accepts a dialog-scoped visible start/end pair and submits both dates", async () => {
	const probe = makePage({
		dialog: true,
		end: { editable: true, enabled: true, visible: true },
		select: false,
		start: { editable: true, enabled: true, visible: true },
	});

	const result = await driveExport(probe.page, ACCOUNT_URL, options());
	assert.equal(result.kind, "artifact");
	if (result.kind === "artifact") {
		rmSync(result.path, { force: true });
		rmSync(result.path.slice(0, result.path.lastIndexOf("/")), {
			recursive: true,
			force: true,
		});
	}
	assert.equal(probe.submitCount(), 1);
	assert.deepEqual(probe.values(), { end: "01/31/2025", start: "01/02/2025" });
});

test("production path selects date-range before validating fields it reveals", async () => {
	const probe = makePage({
		dialog: true,
		select: true,
		selectionRevealsDateFields: true,
	});

	const result = await driveExport(probe.page, ACCOUNT_URL, options());
	assert.equal(result.kind, "artifact");
	if (result.kind === "artifact") {
		rmSync(result.path, { force: true });
		rmSync(result.path.slice(0, result.path.lastIndexOf("/")), {
			recursive: true,
			force: true,
		});
	}
	const events = probe.events();
	const selectionIndex = events.indexOf("select-date-range");
	assert.equal(events[0], "export-click");
	assert.ok(
		selectionIndex > 0,
		"the optional mode must be selected after opening the export dialog",
	);
	assert.ok(events.indexOf("check-actionability:start") > selectionIndex);
	assert.ok(
		events.indexOf("check-actionability:end") >
			events.indexOf("check-actionability:start"),
	);
	assert.equal(probe.submitCount(), 1);
	assert.deepEqual(probe.values(), { end: "01/31/2025", start: "01/02/2025" });
});

test("a present selection control that rejects date-range fails before submit", async () => {
	await assertRejectedBeforeSubmit({
		dialog: true,
		end: { editable: true, enabled: true, visible: true },
		select: true,
		selectFails: true,
		start: { editable: true, enabled: true, visible: true },
	});
});

test("no dialog fails before submit", async () => {
	await assertRejectedBeforeSubmit({ dialog: false });
});

test("dialog with no date fields fails before submit", async () => {
	await assertRejectedBeforeSubmit({ dialog: true });
});

test("dialog with only one date field fails before submit", async () => {
	await assertRejectedBeforeSubmit({ dialog: true, start: { visible: true } });
});

test("hidden date field fails before submit", async () => {
	await assertRejectedBeforeSubmit({
		dialog: true,
		end: { editable: true, enabled: true, visible: true },
		start: { editable: true, enabled: true, visible: false },
	});
});

test("disabled date field fails before submit", async () => {
	await assertRejectedBeforeSubmit({
		dialog: true,
		end: { editable: true, enabled: true, visible: true },
		start: { editable: true, enabled: false, visible: true },
	});
});

test("read-only date field fails before submit", async () => {
	await assertRejectedBeforeSubmit({
		dialog: true,
		end: { editable: true, enabled: true, visible: true },
		start: { editable: false, enabled: true, visible: true },
	});
});

test("visible date fields outside the dialog fail before submit", async () => {
	await assertRejectedBeforeSubmit({
		dialog: true,
		unrelatedOutsideDialog: true,
	});
});

test("a fill failure fails closed before submit", async () => {
	const probe = makePage({
		dialog: true,
		end: { editable: true, enabled: true, visible: true },
		failField: "end",
		select: false,
		start: { editable: true, enabled: true, visible: true },
	});

	const result = await driveExport(probe.page, ACCOUNT_URL, options());
	assert.deepEqual(result, { kind: "failed" });
	assert.equal(
		probe.submitCount(),
		0,
		"end-date fill failure must prevent submit",
	);
	assert.equal(
		probe.values().start,
		"01/02/2025",
		"the first fill may occur, but the parent must stop before submit",
	);
	assert.equal(
		probe.values().end,
		"",
		"the failed field must not receive a partial value",
	);
});

test("a field detached after readiness validation fails closed before submit", async () => {
	const probe = makePage({
		dialog: true,
		detachField: "end",
		end: { editable: true, enabled: true, visible: true },
		select: false,
		start: { editable: true, enabled: true, visible: true },
	});

	const result = await driveExport(probe.page, ACCOUNT_URL, options());
	assert.deepEqual(result, { kind: "failed" });
	assert.equal(probe.submitCount(), 0, "a detached field must prevent submit");
	assert.equal(
		probe.values().start,
		"01/02/2025",
		"the first fill may occur before detachment is observed",
	);
	assert.equal(probe.values().end, "");
});

test("production ladder attempt classifies a fill failure as structural and does not request retry", async () => {
	const probe = makePage({
		dialog: true,
		end: { editable: true, enabled: true, visible: true },
		failField: "end",
		select: false,
		start: { editable: true, enabled: true, visible: true },
	});
	const diagnostics: string[] = [];
	const deps = {
		emit: async (): Promise<void> => undefined,
		emitRecord: async (): Promise<void> => undefined,
	} as EmitDeps;

	const outcome = await runSingleLadderAttempt({
		a: {
			account_id_raw: "fixture-account",
			account_type: "checking",
			account_url: "/my/checking/fixture-account",
			balance_cents: 0,
			last_four: "0000",
			name: "Fixture checking",
			raw_text: "Fixture checking",
		},
		accountOrdinal: 1,
		accountTotal: 1,
		attemptOrdinal: 1,
		attemptTotal: 2,
		context: {} as BrowserContext,
		deps,
		onDiagnostics: (info) => diagnostics.push(info.phase),
		onSessionDead: () => undefined,
		page: probe.page,
		sendInteraction: async () => ({
			request_id: "fixture",
			status: "success",
			type: "INTERACTION_RESPONSE",
		}),
		settleDelayMs: 0,
		sinceDate: "2025-01-02",
		streamState: { sessionDeadMidRun: false, sessionRepairAttempted: false },
		todayIso: "2025-01-31",
	});

	assert.deepEqual(outcome, { kind: "structure_changed" });
	assert.deepEqual(diagnostics, ["export_dialog_fill_failed"]);
});

test("production export ladder stops after a structural fill failure", async () => {
	const probe = makePage({
		dialog: true,
		end: { editable: true, enabled: true, visible: true },
		failField: "end",
		select: false,
		start: { editable: true, enabled: true, visible: true },
	});
	const progress: string[] = [];
	const diagnostics: string[] = [];
	setConnectorDiagnosticSink((line) => {
		diagnostics.push(line);
	});
	const deps = {
		emit: (message: { message?: string }): Promise<void> => {
			if (message.message) {
				progress.push(message.message);
			}
			return Promise.resolve();
		},
		emitRecord: async (): Promise<void> => undefined,
	} as EmitDeps;

	let result: Awaited<ReturnType<typeof tryExportLadder>>;
	try {
		result = await tryExportLadder(
			deps,
			{} as BrowserContext,
			probe.page,
			async () => ({
				request_id: "fixture",
				status: "success",
				type: "INTERACTION_RESPONSE",
			}),
			{
				account_id_raw: "fixture-account",
				account_type: "checking",
				account_url: "/my/checking/fixture-account",
				balance_cents: 0,
				last_four: "0000",
				name: "Fixture checking",
				raw_text: "Fixture checking",
			},
			1,
			1,
			["2025-01-02", "2025-01-10"],
			"2025-01-31",
			{ sessionDeadMidRun: false, sessionRepairAttempted: false },
			() => undefined,
		);
	} finally {
		setConnectorDiagnosticSink(undefined);
	}

	assert.equal(result.csvPath, null);
	assert.equal(
		probe.events().filter((event) => event === "export-click").length,
		1,
	);
	assert.equal(
		progress.some((message) =>
			message.includes("Retrying export with shorter range"),
		),
		false,
	);
	assert.deepEqual(progress, [
		"Waiting for USAA to prepare your transaction export",
		"USAA changed its export page; skipping this account",
	]);
	assertUserFacingProgress(
		progress.map((message) => ({ type: "PROGRESS", message })),
	);
	assert.ok(
		diagnostics.some(
			(line) =>
				line.startsWith("[usaa-diagnostic] export_wait ") &&
				line.includes('"account":1') &&
				line.includes('"window":1') &&
				line.includes('"windows":2'),
		),
		"the account/window ordinals moved to a diagnostic line",
	);
	assert.ok(
		diagnostics.some(
			(line) =>
				line.startsWith("[usaa-diagnostic] export_attempt_failed ") &&
				line.includes('"account":1') &&
				line.includes('"window":1'),
		),
		diagnostics.join("\n"),
	);
	assert.ok(
		diagnostics.some(
			(line) =>
				line.startsWith("[usaa-diagnostic] export_structure_changed ") &&
				line.includes('"phase":'),
		),
		diagnostics.join("\n"),
	);
});

test("PDF parse summary shows plain progress and keeps the template counters in a diagnostic line", async () => {
	const progress: string[] = [];
	const diagnostics: string[] = [];
	setConnectorDiagnosticSink((line) => {
		diagnostics.push(line);
	});
	try {
		await emitPdfStatementTransactions(
			{
				emit: (message: { message?: string }): Promise<void> => {
					if (message.message) {
						progress.push(message.message);
					}
					return Promise.resolve();
				},
				emitRecord: async (): Promise<void> => undefined,
			} as EmitDeps,
			[],
			new Map(),
			[],
		);
	} finally {
		setConnectorDiagnosticSink(undefined);
	}
	assert.deepEqual(progress, ["Read 0 transaction(s) from 0 statement(s)"]);
	assertUserFacingProgress(
		progress.map((message) => ({ type: "PROGRESS", message })),
	);
	assert.deepEqual(diagnostics, [
		'[usaa-diagnostic] pdf_parse_complete {"transactions":0,"statements":0,"unknown_templates":0,"unreconciled":0}',
	]);
});

for (const suffixOutcome of ["success", "empty"] as const) {
	test(`account export: shorter ${suffixOutcome} cannot certify the failed original window`, async () => {
		const run = async (fullWindowWorks: boolean) => {
			const probe = makePage({
				dialog: true,
				start: {},
				end: {},
				outcomeForStart: (start) =>
					start === "01/02/2025"
						? fullWindowWorks
							? "success"
							: "failure"
						: suffixOutcome,
			});
			const messages: Parameters<EmitDeps["emit"]>[0][] = [];
			let records = 0;
			const deps: EmitDeps = {
				emit: async (m) => {
					messages.push(m);
				},
				emitRecord: async () => {
					records += 1;
				},
				servedAccountTransactionGaps: new Map([
					["fixture-account", "gap-original"],
				]),
			};
			const result = await processAccountTransactions(
				deps,
				{} as BrowserContext,
				probe.page,
				async () => ({
					request_id: "fixture",
					status: "success",
					type: "INTERACTION_RESPONSE",
				}),
				{
					account_id_raw: "fixture-account",
					account_type: "checking",
					account_url: "/my/checking/fixture-account",
					balance_cents: 0,
					last_four: "0000",
					name: "Fixture checking",
					raw_text: "Fixture checking",
				},
				null,
				"2025-01-02",
				"2025-01-02",
				{ sessionDeadMidRun: false, sessionRepairAttempted: false },
				1,
				1,
				undefined,
				{ since: "2025-01-02", until: "2025-02-01" },
			);
			assert.ok(result);
			await recoverServedAccountTransactionGaps(deps, [result.outcome]);
			return { result, records, messages, events: probe.events() };
		};
		const partial = await run(false);
		assert.equal(
			partial.events.filter((e) => e.startsWith("submit:")).length,
			2,
			"full export failed then suffix was tried",
		);
		assert.equal(
			partial.result.outcome.kind,
			"gap",
			"suffix success must not certify the original interval",
		);
		assert.equal(
			partial.result.last_date,
			null,
			"uncovered history must hold the watermark",
		);
		assert.equal(
			partial.messages.some((m) => m.type === "DETAIL_GAP_RECOVERED"),
			false,
		);
		if (suffixOutcome === "success")
			assert.ok(partial.records > 0, "keep the useful suffix records");
		const retry = await run(true);
		assert.equal(
			retry.events.find((e) => e.startsWith("submit:")),
			"submit:01/02/2025",
		);
		assert.equal(retry.result.outcome.kind, "hydrated");
		assert.ok(retry.records > 0);
	});
}

for (const suffix of ["rows", "header-only", "empty"] as const) {
	test(`persisted account interval survives next-day ${suffix} fallback`, async (t) => {
		const t0 = Date.parse("2026-06-01T12:00:00Z");
		t.mock.timers.enable({ apis: ["Date"], now: t0 });
		// Keep the calendar deterministic while allowing production deadline loops to expire.
		const clockTick = setInterval(() => t.mock.timers.tick(25), 25);
		t.after(() => clearInterval(clockTick));
		const { BACKFILL_17MO, mmddyyyy } = await import("./parsers.ts");
		const original = new Date(t0 - BACKFILL_17MO).toISOString().slice(0, 10);
		const account = {
			account_id_raw: "fixture-account",
			account_type: "checking",
			account_url: "/my/checking/fixture-account",
			balance_cents: 0,
			last_four: "0000",
			name: "Fixture checking",
			raw_text: "Fixture checking",
		};
		let persisted: Record<string, unknown> = {};
		async function run(day: number, full: boolean, served: boolean) {
			t.mock.timers.setTime(t0 + day * 86400000);
			const messages: Parameters<EmitDeps["emit"]>[0][] = [];
			const probe = makePage({
				start: {},
				end: {},
				outcomeForStart: (start) =>
					start === mmddyyyy(original) && !full
						? "failure"
						: suffix === "empty"
							? "empty"
							: "success",
				csvForStart: (start) =>
					"Date,Description,Amount\n" +
					(suffix === "header-only" ? "" : start + ",Fixture,1.00\n"),
			});
			const deps: EmitDeps = {
				emit: async (m) => {
					messages.push(m);
				},
				emitRecord: async () => {},
				...(served
					? {
							servedAccountTransactionGaps: new Map([
								["fixture-account", "gap-original"],
							]),
						}
					: {}),
			};
			await runTransactionsStream(
				deps,
				{} as BrowserContext,
				probe.page,
				async () => ({
					request_id: "fixture",
					status: "success",
					type: "INTERACTION_RESPONSE",
				}),
				[account],
				persisted,
				new Map([["transactions", { name: "transactions" }]]),
				{ sessionDeadMidRun: false, sessionRepairAttempted: false },
			);
			const states = messages.filter(
				(m) => m.type === "STATE" && m.stream === "transactions",
			);
			const lastState = states.at(-1);
			if (lastState?.type === "STATE")
				persisted = JSON.parse(
					JSON.stringify({ transactions: lastState.cursor }),
				);
			return {
				messages,
				starts: probe.events().filter((e) => e.startsWith("submit:")),
			};
		}
		const first = await run(0, false, false);
		assert.ok(first.messages.some((m) => m.type === "DETAIL_GAP"));
		const saved = (
			persisted.transactions as Record<
				string,
				{
					last_date?: string | null;
					pending_export?: { since: string; until: string };
				}
			>
		)?.["fixture-account"];
		assert.equal(saved?.last_date, null, "no watermark is invented");
		assert.equal(
			saved?.pending_export?.since,
			original,
			"original default start is durably continued",
		);
		const second = await run(1, false, true);
		assert.equal(second.starts[0], "submit:" + mmddyyyy(original));
		assert.equal(
			second.messages.some((m) => m.type === "DETAIL_GAP_RECOVERED"),
			false,
			"shifted default cannot settle original day",
		);
		const third = await run(2, true, true);
		assert.equal(third.starts[0], "submit:" + mmddyyyy(original));
		assert.deepEqual(
			third.messages
				.filter((m) => m.type === "DETAIL_GAP_RECOVERED")
				.map((m) => m.gap_id),
			["gap-original"],
		);
		assert.equal(
			(persisted.transactions as Record<string, { pending_export?: unknown }>)[
				"fixture-account"
			]?.pending_export,
			undefined,
		);
	});
}

for (const [name, prior, since, expectGap] of [
	["legacy unknown start", null, undefined, true],
	["legacy with new explicit start", null, "2025-01-02", true],
	[
		"legacy with watermark but no original interval",
		"2025-02-01",
		undefined,
		true,
	],
] as const) {
	test(`served account interval: ${name}`, async () => {
		const probe = makePage({
			start: {},
			end: {},
			outcomeForStart: () => "empty",
		});
		const messages: Parameters<EmitDeps["emit"]>[0][] = [];
		const deps: EmitDeps = {
			emit: async (m) => {
				messages.push(m);
			},
			emitRecord: async () => {},
			servedAccountTransactionGaps: new Map([
				["fixture-account", "gap-original"],
			]),
		};
		const result = await processAccountTransactions(
			deps,
			{} as BrowserContext,
			probe.page,
			async () => ({
				request_id: "fixture",
				status: "success",
				type: "INTERACTION_RESPONSE",
			}),
			{
				account_id_raw: "fixture-account",
				account_type: "checking",
				account_url: "/my/checking/fixture-account",
				balance_cents: 0,
				last_four: "0000",
				name: "Fixture checking",
				raw_text: "Fixture checking",
			},
			prior,
			since,
			"2025-01-03",
			{ sessionDeadMidRun: false, sessionRepairAttempted: false },
			1,
			1,
		);
		assert.ok(result);
		assert.equal(result.outcome.kind, expectGap ? "gap" : "no_activity");
		if (expectGap) {
			assert.equal(result.last_date, prior);
			assert.equal(result.pending_export?.unknown_original, true);
		}
		await recoverServedAccountTransactionGaps(deps, [result.outcome]);
		assert.deepEqual(
			messages
				.filter((m) => m.type === "DETAIL_GAP_RECOVERED")
				.map((m) => m.gap_id),
			expectGap ? [] : ["gap-original"],
		);
	});
}

for (const format of ["rows", "header-only", "empty"] as const) {
	test(`legacy unknown interval with newly narrowed since survives STATE replay: ${format}`, async () => {
		const account = {
			account_id_raw: "fixture-account",
			account_type: "checking",
			account_url: "/my/checking/fixture-account",
			balance_cents: 0,
			last_four: "0000",
			name: "Fixture checking",
			raw_text: "Fixture checking",
		};
		let persisted: Record<string, unknown> = {};
		for (const since of ["2025-04-01", "2025-05-01"]) {
			const messages: Parameters<EmitDeps["emit"]>[0][] = [];
			let records = 0;
			const probe = makePage({
				start: {},
				end: {},
				outcomeForStart: () => (format === "empty" ? "empty" : "success"),
				csvForStart: (start) =>
					"Date,Description,Amount\n" +
					(format === "header-only" ? "" : start + ",Fixture,1.00\n"),
			});
			const deps: EmitDeps = {
				emit: async (m) => {
					messages.push(m);
				},
				emitRecord: async () => {
					records++;
				},
				servedAccountTransactionGaps: new Map([
					["fixture-account", "gap-legacy-older"],
				]),
			};
			await runTransactionsStream(
				deps,
				{} as BrowserContext,
				probe.page,
				async () => ({
					request_id: "fixture",
					status: "success",
					type: "INTERACTION_RESPONSE",
				}),
				[account],
				persisted,
				new Map([
					["transactions", { name: "transactions", time_range: { since } }],
				]),
				{ sessionDeadMidRun: false, sessionRepairAttempted: false },
			);
			assert.deepEqual(
				messages
					.filter((m) => m.type === "DETAIL_GAP_RECOVERED")
					.map((m) => m.gap_id),
				[],
				"current grant cannot prove the old gap's unknown original interval",
			);
			assert.ok(messages.some((m) => m.type === "DETAIL_GAP"));
			if (format === "rows")
				assert.ok(records > 0, "useful permitted suffix records remain");
			const last = messages
				.filter((m) => m.type === "STATE" && m.stream === "transactions")
				.at(-1);
			assert.ok(last?.type === "STATE");
			persisted = JSON.parse(JSON.stringify({ transactions: last.cursor }));
			const saved = (
				persisted.transactions as Record<
					string,
					{
						last_date: string | null;
						pending_export: { unknown_original?: boolean };
					}
				>
			)["fixture-account"];
			assert.ok(saved, "the fixture account must persist its pending window");
			assert.equal(saved.last_date, null);
			assert.equal(
				saved.pending_export.unknown_original,
				true,
				"unknown remains sticky after configuration changes",
			);
		}
	});
}
