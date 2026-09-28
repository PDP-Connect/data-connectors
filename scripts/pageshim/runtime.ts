// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Runs a PDPP connector's probe() and collect() on the mobile PageShim host
// and maps PDPP protocol messages onto the shim's page API:
//   RECORD   -> buffered, then one page.setData("result", ...) at the end
//   PROGRESS -> page.setProgress
//   SKIP_RESULT -> an entry in result.errors
// Failure output matches mobile's legacy github-1.5.0.js: bad requestedScopes
// is a fatal protocol_violation, and a fatal error yields an empty result
// whose only error is that one, with the class inferred from its message.
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
				get: async (
					url: string,
					opts?: { headers?: Record<string, string> },
				) => {
					const r = await shim.httpFetch(url, {
						method: "GET",
						...(opts?.headers ? { headers: opts.headers } : {}),
					});
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
	/** Every scope the connector serves, e.g. "github.profile". */
	scopes: string[];
	/** The connector manifest's semver. */
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

type ConnectorError = {
	errorClass: string;
	reason: string;
	disposition: string;
	scope?: string;
	phase: string;
};

class FatalRunError extends Error {
	constructor(readonly telemetryError: ConnectorError) {
		super(telemetryError.reason);
	}
}

/** github-1.5.0.js inferErrorClass. */
function inferErrorClass(message: string, fallback = "runtime_error"): string {
	const text = message.toLowerCase();
	if (["auth", "login", "credential"].some((w) => text.includes(w)))
		return "auth_failed";
	if (text.includes("timeout") || text.includes("timed out")) return "timeout";
	if (["network", "fetch", "net::"].some((w) => text.includes(w)))
		return "network_error";
	return fallback;
}

/** github-1.5.0.js resolveRequestedScopes. */
function resolveRequestedScopes(
	raw: unknown,
	connector: PageshimConnector,
): string[] {
	if (raw == null) return [...connector.scopes];
	const fatal = (reason: string) =>
		new FatalRunError({
			errorClass: "protocol_violation",
			reason,
			disposition: "fatal",
			phase: "init",
		});
	if (!Array.isArray(raw) || raw.length === 0)
		throw fatal(
			`${connector.platform} connector received an empty or invalid requestedScopes array.`,
		);
	const deduped = [...new Set(raw as string[])];
	const invalid = deduped.filter((s) => !connector.scopes.includes(s));
	if (invalid.length > 0)
		throw fatal(
			`${connector.platform} connector received unsupported requestedScopes: ${invalid.join(", ")}.`,
		);
	return deduped;
}

export async function runOnPageShim(
	shim: ShimPage,
	connector: PageshimConnector,
): Promise<void> {
	const page = playwrightPageFacade(shim);
	let requestedScopes = [...connector.scopes];
	let initError: unknown = null;
	try {
		requestedScopes = resolveRequestedScopes(shim.requestedScopes(), connector);
	} catch (error) {
		initError = error;
	}
	const prefix = `${connector.platform}.`;
	const requested = new Map(
		requestedScopes
			.filter((s) => s.startsWith(prefix))
			.map((s) => [s.slice(prefix.length), { name: s.slice(prefix.length) }]),
	);
	const records: Record<string, Rec[]> = {};
	const errors: ConnectorError[] = [];
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
			case "SKIP_RESULT": {
				const stream = String(msg.stream);
				const reason = String(msg.message ?? msg.reason);
				errors.push({
					errorClass: inferErrorClass(reason),
					reason,
					disposition: records[stream]?.length ? "degraded" : "omitted",
					scope: `${prefix}${stream}`,
					phase: "collect",
				});
				return;
			}
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
	const result = (
		scopes: Record<string, unknown>,
		resultErrors: ConnectorError[],
	) => ({
		requestedScopes: [...requestedScopes],
		timestamp: new Date().toISOString(),
		version: connector.version,
		platform: connector.platform,
		exportSummary: connector.summarize(scopes),
		errors: resultErrors,
		...scopes,
	});

	try {
		if (initError) throw initError;
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
			isRecordSelected: emitRecord.isSelected,
			page,
			progress: (message: string) =>
				shim.setProgress({ phase: { label: "collect" }, message }),
			requested,
			state,
		});
		const scopes: Record<string, unknown> = {};
		for (const [stream, recs] of Object.entries(records))
			scopes[`${prefix}${stream}`] = connector.toScope(stream, recs);
		const done = result(scopes, errors);
		await shim.setData("result", done);
		await shim.setData(
			"status",
			`Complete! ${done.exportSummary.count} ${done.exportSummary.label}`,
		);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		const fatal =
			error instanceof FatalRunError
				? error.telemetryError
				: {
						errorClass: inferErrorClass(reason),
						reason,
						disposition: "fatal",
						phase: "collect",
					};
		await shim.setData("result", result({}, [fatal]));
		await shim.setData("error", fatal.reason);
	} finally {
		const hits = [
			...new Set(
				(globalThis as { __pdppStubHits?: string[] }).__pdppStubHits ?? [],
			),
		];
		console.log(`[pageshim] stubHits=${JSON.stringify(hits)}`);
	}
}
