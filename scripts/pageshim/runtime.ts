// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Runs a PDPP connector's probe() and collect() on the mobile PageShim host
// and maps PDPP protocol messages onto the shim's page API:
//   RECORD   -> streamed in bounded chunks when enabled; otherwise buffered
//   PROGRESS -> page.setProgress
//   SKIP_RESULT -> an entry in result.errors
// Failure output matches mobile's legacy github-1.5.0.js: bad requestedScopes
// is a fatal protocol_violation, and a fatal error yields an empty result
// whose only error is that one, with the class inferred from its message.
//   STATE    -> awaited page.setData("STATE", ...) and retained for this run
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
	readZipEntryChunk?: (
		handle: string | null,
		entryName: string,
		offset: number,
		length: number,
	) => Promise<{ ok: boolean; text?: string; error?: string }>;
}

type Msg = { type: string; [k: string]: unknown };
type Rec = Record<string, unknown>;

const PAGE_BRIDGE_MAX_UNITS = 256 * 1024;
// JSON text is escaped again when the platform bridge serializes its envelope.
// Leave room for that second encoding and the message fields.
const RESULT_CHUNK_MAX_UNITS = 125 * 1024;
const EVALUATE_INLINE_MAX_UNITS = 64 * 1024;
const EVALUATE_CHUNK_MAX_UNITS = 64 * 1024;
const EVALUATE_RESULT_MAX_UNITS = 64 * 1024 * 1024;
const ERROR_TEXT_MAX_UNITS = 4 * 1024;
const EVALUATE_RESULT_STORE = "__pdppPageshimEvaluateResults";
const DEFAULT_BRIDGE_CALL_TIMEOUT_MS = 30_000;

declare const PAGESHIM_BRIDGE_CALL_TIMEOUT_MS: number;

function withBridgeCallTimeout(
	shim: ShimPage,
	onBridgeCall: (
		method: string,
		args: unknown[],
		result: unknown,
		elapsedMs: number,
	) => void,
): ShimPage {
	const timeoutMs =
		typeof PAGESHIM_BRIDGE_CALL_TIMEOUT_MS === "number" &&
		PAGESHIM_BRIDGE_CALL_TIMEOUT_MS > 0
			? PAGESHIM_BRIDGE_CALL_TIMEOUT_MS
			: DEFAULT_BRIDGE_CALL_TIMEOUT_MS;
	return new Proxy(shim, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (property === "requestedScopes" || typeof value !== "function")
				return value;
			return async (...args: unknown[]) => {
				const started = performance.now();
				let timer: ReturnType<typeof setTimeout> | undefined;
				let result: unknown;
				try {
					result = await Promise.race([
						value.apply(target, args),
						new Promise<never>((_, reject) => {
							timer = setTimeout(
								() =>
									reject(
										new Error(
											`PageShim bridge call ${String(property)} timed out after ${timeoutMs}ms`,
										),
									),
								timeoutMs,
							);
						}),
					]);
					return result;
				} finally {
					if (timer) clearTimeout(timer);
					try {
						onBridgeCall(
							String(property),
							args,
							result,
							performance.now() - started,
						);
					} catch {
						// Measurement must not change bridge-call behavior.
					}
				}
			};
		},
	}) as ShimPage;
}

declare const PAGESHIM_RESULT_STREAMING: boolean;

function resultStreamingEnabled(): boolean {
	return (
		typeof PAGESHIM_RESULT_STREAMING !== "undefined" &&
		PAGESHIM_RESULT_STREAMING
	);
}

function boundedPageEvaluate(shim: ShimPage) {
	let nextId = 0;
	return async (code: string): Promise<unknown> => {
		if (code.length > PAGE_BRIDGE_MAX_UNITS / 4) {
			throw new Error(
				`PageShim evaluation request exceeds ${PAGE_BRIDGE_MAX_UNITS / 4} UTF-16 code units`,
			);
		}
		const id = `pageshim-${nextId++}`;
		const wrapped = `(async () => {
			let value;
			try {
				value = await (${code});
				const json = JSON.stringify(value);
				if (json === undefined) return { type: "undefined" };
				if (json.length > ${EVALUATE_RESULT_MAX_UNITS}) {
					return { type: "too-large", length: json.length };
				}
				if (json.length <= ${EVALUATE_INLINE_MAX_UNITS}) {
					return { type: "value", value };
				}
				const store = globalThis[${JSON.stringify(EVALUATE_RESULT_STORE)}] ||
					(globalThis[${JSON.stringify(EVALUATE_RESULT_STORE)}] = Object.create(null));
				store[${JSON.stringify(id)}] = json;
				return { type: "chunked", id: ${JSON.stringify(id)}, length: json.length };
			} catch (error) {
				return { type: "error", message: String(error?.message ?? error).slice(0, 1000) };
			}
		})()`;
		const response = (await shim.evaluate(wrapped)) as {
			type?: string;
			value?: unknown;
			id?: string;
			length?: number;
			message?: string;
		};
		if (response?.type === "undefined") return undefined;
		if (response?.type === "value") return response.value;
		if (response?.type === "too-large") {
			throw new Error(
				`PageShim evaluation result is ${response.length} UTF-16 code units; the per-item limit is ${EVALUATE_RESULT_MAX_UNITS}`,
			);
		}
		if (response?.type === "error") {
			throw new Error(
				`PageShim evaluation failed: ${response.message ?? "unknown error"}`,
			);
		}
		if (
			response?.type !== "chunked" ||
			response.id !== id ||
			!Number.isSafeInteger(response.length) ||
			(response.length ?? 0) <= EVALUATE_INLINE_MAX_UNITS ||
			(response.length ?? 0) > EVALUATE_RESULT_MAX_UNITS
		) {
			throw new Error(
				"PageShim evaluation returned an invalid transfer marker",
			);
		}

		const chunks: string[] = [];
		try {
			for (let offset = 0; offset < response.length; ) {
				const end = Math.min(
					offset + EVALUATE_CHUNK_MAX_UNITS,
					response.length,
				);
				const piece = await shim.evaluate(
					`globalThis[${JSON.stringify(EVALUATE_RESULT_STORE)}]?.[${JSON.stringify(id)}]?.slice(${offset}, ${end}) ?? null`,
				);
				if (
					typeof piece !== "string" ||
					piece.length === 0 ||
					piece.length > EVALUATE_CHUNK_MAX_UNITS
				) {
					throw new Error(
						"PageShim evaluation chunk exceeded its transfer bound",
					);
				}
				chunks.push(piece);
				offset += piece.length;
			}
			const json = chunks.join("");
			if (json.length !== response.length) {
				throw new Error(
					"PageShim evaluation chunks did not match their declared size",
				);
			}
			return JSON.parse(json);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`PageShim evaluation transfer failed: ${reason}`);
		} finally {
			await shim.evaluate(
				`delete globalThis[${JSON.stringify(EVALUATE_RESULT_STORE)}]?.[${JSON.stringify(id)}]`,
			);
		}
	};
}

/** The Playwright `Page` members that connectors on this target call, over the shim. */
export function playwrightPageFacade(shim: ShimPage) {
	const evaluateInPage = boundedPageEvaluate(shim);
	const evaluate = (fn: unknown, arg?: unknown): Promise<unknown> =>
		evaluateInPage(
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
			(await evaluateInPage("document.documentElement.outerHTML")) as string,
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
	prepareProbe?: (
		page: ReturnType<typeof playwrightPageFacade>,
	) => Promise<void>;
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
	pageShim: ShimPage,
	connector: PageshimConnector,
	initialState: Record<string, unknown> = {},
	supportsState = false,
): Promise<void> {
	let observeBridgeCall:
		| ((
				method: string,
				args: unknown[],
				result: unknown,
				elapsedMs: number,
		  ) => void)
		| null = null;
	const shim = withBridgeCallTimeout(
		pageShim,
		(method, args, result, elapsedMs) =>
			observeBridgeCall?.(method, args, result, elapsedMs),
	);
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
	const scopeByStream = new Map(
		connector.scopes
			.filter((scope) => scope.startsWith(prefix))
			.map((scope) => [scope.slice(prefix.length), scope]),
	);
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
	for (const [stream, scope] of scopeByStream)
		if (Object.hasOwn(initialState, scope)) state[stream] = initialState[scope];
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
	let activeChunkConversationIds = new Set<string>();
	let streamedScopeCount = 0;
	let streamFailure: Error | null = null;
	const conversationTimings = new Map<
		string,
		{
			providerFetchMs: number;
			jsProcessMs: number;
			bridgeMs: number;
			bridgeCalls: string[];
			bridgeBytes: number;
			roundTrips: number;
			ackMs: number;
			bytes: number;
		}
	>();
	let activeTimingConversationIds: string[] = [];
	(globalThis as Record<string, unknown>).__pdppPageshimDetailFetched = (
		conversationId: string,
		_providerDetailMs: number,
		providerFetchMs: number,
	) => {
		const current = conversationTimings.get(conversationId);
		if (current) current.providerFetchMs += providerFetchMs;
		else {
			conversationTimings.set(conversationId, {
				providerFetchMs,
				jsProcessMs: 0,
				bridgeMs: 0,
				bridgeCalls: [],
				bridgeBytes: 0,
				roundTrips: 0,
				ackMs: 0,
				bytes: 0,
			});
		}
	};
	(globalThis as Record<string, unknown>).__pdppPageshimDetailProcessed = (
		conversationId: string,
		processingMs: number,
	) => {
		const timing = conversationTimings.get(conversationId);
		if (timing) timing.jsProcessMs += processingMs;
	};
	(globalThis as Record<string, unknown>).__pdppPageshimSetTimingConversation =
		(conversationIds: string[] | null) => {
			activeTimingConversationIds = conversationIds ?? [];
			for (const id of activeTimingConversationIds) {
				if (!conversationTimings.has(id)) {
					conversationTimings.set(id, {
						providerFetchMs: 0,
						jsProcessMs: 0,
						bridgeMs: 0,
						bridgeCalls: [],
						bridgeBytes: 0,
						roundTrips: 0,
						ackMs: 0,
						bytes: 0,
					});
				}
			}
		};
	const utf8Bytes = (value: unknown): number => {
		try {
			const text =
				typeof value === "string" ? value : (JSON.stringify(value) ?? "");
			return new TextEncoder().encode(text).length;
		} catch {
			return 0;
		}
	};
	observeBridgeCall = (method, args, result, elapsedMs) => {
		const chunkIds =
			method === "setData" && args[0] === "result:chunk"
				? [...activeChunkConversationIds]
				: [];
		const recipients = chunkIds.length ? chunkIds : activeTimingConversationIds;
		if (recipients.length === 0) return;
		const requestBytes = utf8Bytes(args);
		const responseBytes = utf8Bytes(result);
		const label =
			method === "setData" && typeof args[0] === "string"
				? `setData(${args[0]})`
				: method;
		for (const id of recipients) {
			const timing = conversationTimings.get(id);
			if (!timing) continue;
			timing.roundTrips++;
			timing.bridgeMs += elapsedMs;
			timing.ackMs += elapsedMs;
			timing.bridgeCalls.push(
				`${label}:${elapsedMs.toFixed(1)}ms/${requestBytes}+${responseBytes}B`,
			);
			timing.bridgeBytes += requestBytes + responseBytes;
		}
	};
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
	const sendStreamText = async (
		scope: string,
		text: string,
	): Promise<void> => {
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
		activeChunkConversationIds = new Set();
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
			if (stream === "messages") {
				const conversationId = String(record.conversation_id ?? "");
				if (conversationId) {
					const timing = conversationTimings.get(conversationId);
					if (timing)
						timing.bytes += new TextEncoder().encode(serialized).length;
					activeChunkConversationIds.add(conversationId);
				}
			}
			try {
				if (activeRecordCount > 0)
					await sendStreamText(`${prefix}${stream}`, ",");
				await sendStreamText(`${prefix}${stream}`, serialized);
			} finally {
				activeChunkConversationIds.clear();
			}
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
		if (activeStream === "messages") {
			let ordinal = 0;
			for (const timing of conversationTimings.values()) {
				ordinal++;
				console.info(
					`[chatgpt-timing] conversation=${ordinal} providerFetchMs=${Math.round(timing.providerFetchMs)} jsProcessMs=${Math.round(timing.jsProcessMs)} bridgeCalls=${timing.bridgeCalls.join("|")} bridgeBytes=${timing.bridgeBytes} bridgeMs=${Math.round(timing.bridgeMs)} bridgeRoundTrips=${timing.roundTrips} shellAckMs=${Math.round(timing.ackMs)} bytes=${timing.bytes}`,
				);
			}
		}
		streamedScopeCount++;
		activeStream = null;
	};
	const isHighSurrogate = (unit: number): boolean =>
		unit >= 0xd800 && unit <= 0xdbff;
	const emitMessage = async (msg: Msg): Promise<void> => {
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
			case "STATE": {
				const stream = String(msg.stream);
				const scope = scopeByStream.get(stream);
				if (!scope) throw new Error(`unsupported STATE stream: ${stream}`);
				if (supportsState)
					await shim.setData("STATE", {
						type: "STATE",
						stream: scope,
						cursor: msg.cursor,
					});
				state[stream] = msg.cursor;
				return;
			}
			case "SKIP_RESULT": {
				const stream = String(msg.stream);
				const reason = String(msg.message ?? msg.reason).slice(
					0,
					ERROR_TEXT_MAX_UNITS,
				);
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
					message: String(msg.message ?? "").slice(0, ERROR_TEXT_MAX_UNITS),
					count: msg.count,
				});
				return;
			default:
				console.log(`pageshim: PDPP message ${msg.type} ignored`);
		}
	};
	const pendingStateWrites = new Set<Promise<void>>();
	let stateWriteFailure: Error | null = null;
	const emit = (msg: Msg): Promise<void> => {
		const pending = emitMessage(msg);
		if (msg.type === "STATE") {
			const settled = pending.then(
				() => undefined,
				(error: unknown) => {
					stateWriteFailure ??=
						error instanceof Error ? error : new Error(String(error));
				},
			);
			pendingStateWrites.add(settled);
			void settled.finally(() => pendingStateWrites.delete(settled));
		}
		return pending;
	};
	const settleStateWrites = async (): Promise<void> => {
		while (pendingStateWrites.size > 0) {
			await Promise.all([...pendingStateWrites]);
		}
		if (stateWriteFailure) throw stateWriteFailure;
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
				shim.setProgress({
					phase: { label: "collect" },
					message: message.slice(0, ERROR_TEXT_MAX_UNITS),
				}),
			requested,
			state,
		});
		// Some connectors emit STATE without awaiting the returned promise. Drain
		// those host acknowledgements before committing the streamed result.
		await settleStateWrites();
		for (const stream of connector.partialStreamsFromDetailGaps?.([
			...requested.keys(),
		]) ?? []) {
			if (detailGapStreams.has(stream)) {
				errors.push({
					errorClass: "partial",
					reason:
						"PageShim collected a bounded ChatGPT prefix with conversation details pending. PageShim does not persist STATE or DETAIL_GAP recovery state, so another PageShim run starts a new bounded walk instead of resuming this omitted tail.",
					disposition:
						records[stream]?.length || streamCounts[stream]
							? "degraded"
							: "omitted",
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
				const exportSummary = streamConfig.summarizeCounts(streamCounts);
				const metadata = {
					...exportSummary,
					...(windowSince
						? {
								window: { since: windowSince, sinceDays: connector.sinceDays },
								partial: true,
								partialReason: "time_window",
							}
						: {}),
				};
				await sendStreamMessage("result:done", {
					scopeCount: streamedScopeCount,
					exportSummary: metadata,
					errors,
				});
				const completion =
					errors.length > 0
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
		const serialized = JSON.stringify(done);
		if (serialized.length > RESULT_CHUNK_MAX_UNITS) {
			throw new Error(
				`PageShim result exceeds the ${RESULT_CHUNK_MAX_UNITS}-unit legacy bridge limit; enable streamed results`,
			);
		}
		await shim.setData("result", done);
		await shim.setData(
			"status",
			errors.some((error) => error.errorClass === "partial")
				? `Partial: ${done.exportSummary.count} ${done.exportSummary.label}`
				: `Complete! ${done.exportSummary.count} ${done.exportSummary.label}`,
		);
	} catch (error) {
		const reason = (
			error instanceof Error ? error.message : String(error)
		).slice(0, ERROR_TEXT_MAX_UNITS);
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
