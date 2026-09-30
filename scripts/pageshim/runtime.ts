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

const RESULT_CHUNK_MAX_UNITS = 256 * 1024;

declare const PAGESHIM_RESULT_STREAMING: boolean;

function resultStreamingEnabled(): boolean {
	return (
		typeof PAGESHIM_RESULT_STREAMING !== "undefined" &&
		PAGESHIM_RESULT_STREAMING
	);
}

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
	/** Fixed, opt-in lookback window embedded in this bundle. */
	sinceDays?: number;
	loginUrl: string;
	loginMessage: string;
	validateRecord: Parameters<typeof makeEmitRecord>[0]["validateRecord"];
	probe: (page: ReturnType<typeof playwrightPageFacade>) => Promise<boolean>;
	/** Optional one-time navigation before the first probe; repeated probes must be observational. */
	prepareProbe?: (page: ReturnType<typeof playwrightPageFacade>) => Promise<void>;
	collect: (ctx: Record<string, unknown>) => Promise<void>;
	/** PDPP records of one stream -> the scope payload the host stores. */
	toScope: (stream: string, records: Rec[]) => unknown;
	/** Optional incremental form for connectors whose scope value is `{records}`. */
	streamScopeRecords?: {
		/** Large streams first; later streams remain buffered until the active scope closes. */
		order: string[];
		/** Per-record cleanup matching `toScope`, when required. */
		toRecord?: (stream: string, record: Rec) => unknown;
		summarizeCounts: (counts: Record<string, number>) => {
			count: number;
			label: string;
			details: unknown;
		};
	};
	/** The host's `exportSummary`, computed from the finished scopes. */
	summarize: (scopes: Record<string, unknown>) => {
		count: number;
		label: string;
		details: unknown;
	};
	/** Streams where pending DETAIL_GAPs mean the PageShim result is partial. */
	partialStreamsFromDetailGaps?: (streams: string[]) => string[];
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
	const windowSince =
		connector.sinceDays && connector.sinceDays > 0
			? new Date(Date.now() - connector.sinceDays * 86_400_000).toISOString()
			: undefined;
	const requested = new Map(
		requestedScopes
			.filter((s) => s.startsWith(prefix))
			.map((s) => [
				s.slice(prefix.length),
				{
					name: s.slice(prefix.length),
					...(windowSince ? { time_range: { since: windowSince } } : {}),
				},
			]),
	);
	const records: Record<string, Rec[]> = {};
	const errors: ConnectorError[] = [];
	const state: Record<string, unknown> = {};
	const detailGapStreams = new Set<string>();
	const streamConfig =
		resultStreamingEnabled() && connector.streamScopeRecords
			? connector.streamScopeRecords
			: null;
	const pendingRecords: Record<string, Rec[]> = {};
	const streamCounts: Record<string, number> = {};
	let streamProtocolUsed = false;
	let activeStream: string | null = null;
	let activeSequence = 0;
	let activeRecordCount = 0;
	let streamedScopeCount = 0;
	let streamFailure: Error | null = null;
	const sendStreamMessage = async (
		key: string,
		value: unknown,
	): Promise<void> => {
		try {
			await shim.setData(key, value);
		} catch (error) {
			streamFailure = error instanceof Error ? error : new Error(String(error));
			throw streamFailure;
		}
	};
	const sendStreamText = async (scope: string, text: string): Promise<void> => {
		for (let offset = 0; offset < text.length; ) {
			let end = Math.min(offset + RESULT_CHUNK_MAX_UNITS, text.length);
			if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end--;
			const piece = text.slice(offset, end);
			await sendStreamMessage("result:chunk", {
				scope,
				sequence: activeSequence,
				text: piece,
			});
			activeSequence++;
			offset = end;
		}
	};
	const beginStreamScope = async (stream: string): Promise<void> => {
		const scope = `${prefix}${stream}`;
		streamProtocolUsed = true;
		await sendStreamMessage("result:begin", { scope });
		activeStream = stream;
		activeSequence = 0;
		activeRecordCount = 0;
		await sendStreamText(scope, '{"records":[');
	};
	const appendStreamRecord = async (
		stream: string,
		record: Rec,
	): Promise<void> => {
		if (activeStream !== stream)
			throw new Error("PageShim stream scope order changed");
		try {
			const value = streamConfig?.toRecord
				? streamConfig.toRecord(stream, record)
				: record;
			const serialized = JSON.stringify(value);
			if (serialized === undefined)
				throw new Error("PageShim stream record could not be serialized");
			if (activeRecordCount > 0)
				await sendStreamText(`${prefix}${stream}`, ",");
			await sendStreamText(`${prefix}${stream}`, serialized);
			activeRecordCount++;
		} catch (error) {
			streamFailure = error instanceof Error ? error : new Error(String(error));
			throw streamFailure;
		}
	};
	const finishStreamScope = async (): Promise<void> => {
		if (activeStream === null) return;
		const scope = `${prefix}${activeStream}`;
		await sendStreamText(scope, "]}");
		await sendStreamMessage("result:scope-done", {
			scope,
			chunkCount: activeSequence,
		});
		streamedScopeCount++;
		activeStream = null;
	};
	const isHighSurrogate = (unit: number): boolean =>
		unit >= 0xd800 && unit <= 0xdbff;
	const emit = async (msg: Msg): Promise<void> => {
		if (streamFailure) throw streamFailure;
		switch (msg.type) {
			case "RECORD": {
				const stream = String(msg.stream);
				streamCounts[stream] = (streamCounts[stream] ?? 0) + 1;
				if (streamConfig) {
					const target = streamConfig.order[0];
					if (!streamConfig.order.includes(stream))
						throw new Error(`PageShim stream serializer missing ${stream}`);
					if (stream === target) {
						if (activeStream === null) await beginStreamScope(stream);
						await appendStreamRecord(stream, msg.data as Rec);
					} else {
						pendingRecords[stream] ??= [];
						pendingRecords[stream].push(msg.data as Rec);
					}
				} else {
					records[stream] ??= [];
					records[stream].push(msg.data as Rec);
				}
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
					disposition: (streamCounts[stream] ?? 0) ? "degraded" : "omitted",
					scope: `${prefix}${stream}`,
					phase: "collect",
				});
				return;
			}
			case "DETAIL_GAP": {
				const stream = String(msg.stream);
				detailGapStreams.add(stream);
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
		if (connector.prepareProbe) await connector.prepareProbe(page);
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
		for (const stream of connector.partialStreamsFromDetailGaps?.([
			...requested.keys(),
		]) ?? []) {
			if (detailGapStreams.has(stream)) {
				errors.push({
					errorClass: "partial",
					reason: "PageShim collected a bounded ChatGPT prefix with conversation details pending. PageShim does not persist STATE or DETAIL_GAP recovery state, so another PageShim run starts a new bounded walk instead of resuming this omitted tail.",
					disposition: records[stream]?.length || streamCounts[stream] ? "degraded" : "omitted",
					scope: `${prefix}${stream}`,
					phase: "collect",
				});
			}
		}
		if (windowSince) {
			const hasRecords = Object.values(streamCounts).some((count) => count > 0);
			errors.push({
				errorClass: "partial",
				reason: "time_window",
				disposition: hasRecords ? "degraded" : "omitted",
				phase: "collect",
			});
		}
		if (streamFailure) throw streamFailure;
		if (streamConfig) {
			await finishStreamScope();
			for (const stream of streamConfig.order) {
				const buffered = pendingRecords[stream];
				if (!buffered?.length) continue;
				await beginStreamScope(stream);
				for (const record of buffered) await appendStreamRecord(stream, record);
				await finishStreamScope();
			}
			if (streamedScopeCount > 0) {
				const scopesForSummary = Object.fromEntries(
					Object.entries(streamCounts).map(([stream, count]) => [
						`${prefix}${stream}`,
						{ records: Array.from({ length: count }) },
					]),
				);
				const exportSummary = streamConfig.summarizeCounts(streamCounts);
				const metadata = {
					...exportSummary,
					...(windowSince ? {
						window: { since: windowSince, sinceDays: connector.sinceDays },
						partial: true,
						partialReason: "time_window",
					} : {}),
				};
				await sendStreamMessage("result:done", {
					scopeCount: streamedScopeCount,
					exportSummary: metadata,
					errors,
				});
				const completion = errors.length > 0
					? `Partial: ${metadata.count} ${metadata.label}`
					: `Complete! ${metadata.count} ${metadata.label}`;
				await shim.setData("status", completion);
				return;
			}
		}
		const scopes: Record<string, unknown> = {};
		for (const [stream, recs] of Object.entries(records))
			scopes[`${prefix}${stream}`] = connector.toScope(stream, recs);
		const done = result(scopes, errors);
		if (windowSince) {
			done.exportSummary = {
				...done.exportSummary,
				window: { since: windowSince, sinceDays: connector.sinceDays },
				partial: true,
				partialReason: "time_window",
			};
		}
		await shim.setData("result", done);
		await shim.setData(
			"status",
			errors.some((error) => error.errorClass === "partial")
				? `Partial: ${done.exportSummary.count} ${done.exportSummary.label}`
				: `Complete! ${done.exportSummary.count} ${done.exportSummary.label}`,
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
		if (!streamProtocolUsed) await shim.setData("result", result({}, [fatal]));
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
