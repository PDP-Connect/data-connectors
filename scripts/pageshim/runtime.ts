// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Runs a PDPP connector's probe() and collect() on the mobile PageShim host
// and maps PDPP protocol messages onto the shim's page API:
//   RECORD   -> buffered, then one page.setData("result", ...) at the end
//   PROGRESS -> page.setProgress
//   SKIP_RESULT -> an entry in result.errors
//   STATE    -> dropped (the host has no cursor store between runs)
//
// It does not call runConnector(): that is the stdio + Patchright runtime.
// It reuses makeEmitRecord, so record validation and scope filtering match
// the desktop path.
import { makeEmitRecord } from "../../packages/polyfill-connectors/src/connector-runtime.ts";

/** The subset of the PageShim page API this adapter calls. */
export interface ShimPage {
	requestedScopes: () => string[];
	evaluate: (code: string) => Promise<unknown>;
	goto: (url: string) => Promise<null>;
	sleep: (ms: number) => Promise<void>;
	setData: (key: string, value: unknown) => Promise<void>;
	setProgress: (p: unknown) => Promise<void>;
	showBrowser: (url?: string) => Promise<{ headed: boolean }>;
	goHeadless: () => Promise<void>;
	httpFetch: (
		url: string,
		opts?: unknown,
	) => Promise<{
		ok: boolean;
		status: number;
		text: string;
		json: unknown;
		headers: Record<string, string>;
	}>;
	promptUser: (
		msg: string,
		check: () => Promise<boolean>,
		interval?: number,
	) => Promise<boolean>;
}

type Msg = { type: string; [k: string]: unknown };
type Rec = Record<string, unknown>;

/** The Playwright `Page` members that connectors on this target call, over the shim. */
export function playwrightPageFacade(shim: ShimPage) {
	const evaluate = (fn: unknown, arg?: unknown): Promise<unknown> =>
		shim.evaluate(
			typeof fn === "function"
				? `(${fn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})`
				: String(fn),
		);
	const facade = {
		goto: async (url: string, _opts?: unknown) => {
			await shim.goto(url);
			return null; // Playwright returns a Response; the shim returns nothing.
		},
		content: async () =>
			(await shim.evaluate("document.documentElement.outerHTML")) as string,
		evaluate,
		waitForFunction: async (
			fn: unknown,
			arg: unknown,
			opts?: { timeout?: number; polling?: number },
		) => {
			const timeout = opts?.timeout ?? 30_000;
			const started = Date.now();
			for (;;) {
				if (await evaluate(fn, arg)) return { dispose: async () => {} };
				if (Date.now() - started >= timeout)
					throw new Error(`waitForFunction timed out after ${timeout}ms`);
				await shim.sleep(
					typeof opts?.polling === "number" ? opts.polling : 200,
				);
			}
		},
		context: () => ({
			request: {
				get: async (url: string, _opts?: unknown) => {
					const r = await shim.httpFetch(url, { method: "GET" });
					return {
						ok: () => r.ok,
						status: () => r.status,
						text: async () => r.text,
						json: async () => r.json,
						headers: () => r.headers,
						dispose: async () => {},
					};
				},
			},
		}),
	};
	// A member the facade lacks reads as undefined, as a `typeof` probe
	// expects, and is recorded so the harness can fail on it.
	return new Proxy(facade, {
		get(t, k) {
			if (k in t) return (t as Record<string | symbol, unknown>)[k];
			if (typeof k === "string")
				(globalThis as { __pdppStubHits?: string[] }).__pdppStubHits?.push(
					`Page.${k} (facade)`,
				);
			return undefined;
		},
	});
}

export interface PageshimConnector {
	/** Scope prefix, e.g. "github". */
	platform: string;
	version: string;
	loginUrl: string;
	loginMessage: string;
	validateRecord: Parameters<typeof makeEmitRecord>[0]["validateRecord"];
	probe: (page: ReturnType<typeof playwrightPageFacade>) => Promise<boolean>;
	collect: (ctx: Record<string, unknown>) => Promise<void>;
	/** PDPP records of one stream -> the scope payload the host stores. */
	toScope: (stream: string, records: Rec[]) => unknown;
	/** The host's `exportSummary`, computed from the finished scopes. */
	summarize: (scopes: Record<string, unknown>) => {
		count: number;
		label: string;
		details: unknown;
	};
}

export async function runOnPageShim(
	shim: ShimPage,
	connector: PageshimConnector,
): Promise<void> {
	const page = playwrightPageFacade(shim);
	const requestedScopes = shim.requestedScopes();
	const prefix = `${connector.platform}.`;
	const requested = new Map(
		requestedScopes
			.filter((s) => s.startsWith(prefix))
			.map((s) => [s.slice(prefix.length), { name: s.slice(prefix.length) }]),
	);
	const records: Record<string, Rec[]> = {};
	const errors: unknown[] = [];
	const state: Record<string, unknown> = {};
	const emit = async (msg: Msg): Promise<void> => {
		switch (msg.type) {
			case "RECORD": {
				const stream = String(msg.stream);
				records[stream] ??= [];
				records[stream].push(msg.data as Rec);
				return;
			}
			case "STATE":
				state[String(msg.stream)] = msg.cursor;
				return;
			case "SKIP_RESULT":
				errors.push({
					errorClass: "incomplete",
					reason: String(msg.message ?? msg.reason),
					disposition: "omitted",
					scope: `${prefix}${String(msg.stream)}`,
					phase: "collect",
				});
				return;
			case "PROGRESS":
				await shim.setProgress({
					phase: { label: String(msg.stream ?? "collect") },
					message: String(msg.message ?? ""),
					count: msg.count,
				});
				return;
			default:
				console.log(`pageshim: PDPP message ${msg.type} ignored`);
		}
	};
	const emitRecord = makeEmitRecord({
		requested: requested as never,
		emit: emit as never,
		emittedAt: new Date().toISOString(),
		validateRecord: connector.validateRecord,
		isTombstone: undefined,
		timeRangeFieldFor: () => "date",
	});
	const result = (scopes: Record<string, unknown>) => ({
		requestedScopes,
		timestamp: new Date().toISOString(),
		version: connector.version,
		platform: connector.platform,
		exportSummary: connector.summarize(scopes),
		errors,
		...scopes,
	});

	try {
		await shim.setData("status", `Checking ${connector.platform} login...`);
		if (!(await connector.probe(page))) {
			await page.goto(connector.loginUrl);
			await shim.showBrowser(connector.loginUrl);
			// promptUser throws when the host's login wait runs out.
			await shim.promptUser(
				connector.loginMessage,
				() => connector.probe(page),
				2000,
			);
			await shim.goHeadless();
		}
		await connector.collect({
			emit,
			emitRecord: emitRecord.emit,
			page,
			progress: (message: string) =>
				shim.setProgress({ phase: { label: "collect" }, message }),
			requested,
			state,
		});
		const scopes: Record<string, unknown> = {};
		for (const [stream, recs] of Object.entries(records))
			scopes[`${prefix}${stream}`] = connector.toScope(stream, recs);
		const done = result(scopes);
		await shim.setData("result", done);
		await shim.setData(
			"status",
			`Complete! ${done.exportSummary.count} ${done.exportSummary.label}`,
		);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		errors.push({
			errorClass: "runtime_error",
			reason,
			disposition: "fatal",
			phase: "collect",
		});
		await shim.setData("result", result({}));
		await shim.setData("error", reason);
	} finally {
		const hits = [
			...new Set(
				(globalThis as { __pdppStubHits?: string[] }).__pdppStubHits ?? [],
			),
		];
		console.log(`[pageshim] stubHits=${JSON.stringify(hits)}`);
	}
}
