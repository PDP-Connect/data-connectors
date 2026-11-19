// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Runs a PDPP connector's probe() and collect() on the mobile PageShim host
// and maps PDPP protocol messages onto the shim's page API:
//   RECORD   -> streamed in bounded chunks when the host offers page.input;
//               otherwise buffered
//   PROGRESS -> page.setProgress
//   SKIP_RESULT -> an entry in result.errors
// Failure output matches mobile's legacy github-1.5.0.js: bad requestedScopes
// is a fatal protocol_violation, and a fatal error yields an empty result
// whose only error is that one, with the class inferred from its message.
//   STATE    -> awaited page.setData("STATE", ...) and retained for this run
//
// The shared lifecycle owns START, record gates, failures and DONE. This
// adapter owns login, protocol evidence delivery and the result spool.
import {
	consentTimeFieldResolver,
	type EmittedMessage,
	type makeEmitRecord,
	type RunConnectorConfig,
	runConnectorLifecycle,
	type StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	TerminalError,
	type TerminalErrorDetails,
} from "../../packages/polyfill-connectors/src/terminal-error.ts";
import { timeRangeUnsupportedReason } from "../../packages/polyfill-connectors/src/time-range.ts";
import {
	CollectionOutcome,
	type ConnectorError,
	fatalCollectionError,
} from "./collection-outcome.ts";

/** Set by build.mjs: the connector directory whose manifest declares the streams. */
declare const PAGESHIM_CONNECTOR_MANIFEST: string | undefined;

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
const MAX_TIMING_BRIDGE_CALLS = 32;
const EVALUATE_INLINE_MAX_UNITS = 64 * 1024;
// A slice is JSON text that the bridge escapes again, so it uses the request
// bound mobile-host-v1 amendment A4 sets for escape-heavy chunks: twice this
// stays under PAGE_BRIDGE_MAX_UNITS.
const EVALUATE_CHUNK_MAX_UNITS = 120 * 1024;
// Slice reads in flight for one large evaluation result.
const EVALUATE_READS_IN_FLIGHT = 4;
const EVALUATE_RESULT_MAX_UNITS = 64 * 1024 * 1024;
const ERROR_TEXT_MAX_UNITS = 4 * 1024;
const EVALUATE_RESULT_STORE = "__pdppPageshimEvaluateResults";
const DEFAULT_BRIDGE_CALL_TIMEOUT_MS = 30_000;

declare const PAGESHIM_BRIDGE_CALL_TIMEOUT_MS: number;

// Calls that wait for a person, not for the host. The host bounds them with
// its own login wait, so the per-call bridge timeout does not apply.
// A serializer or bridge rejection can carry row content in its message
// (a JSON error quoting a value, a host echoing a payload). Diagnostics get a
// fixed class and an error name from a fixed vocabulary, never the message.
const SAFE_ERROR_NAMES = new Set([
	"Error",
	"TypeError",
	"RangeError",
	"SyntaxError",
	"TimeoutError",
	"AbortError",
]);
type FailureClass =
	| "serialize_failed"
	| "bridge_rejected"
	| "bridge_timeout"
	| "login_wait_failed"
	| "evaluate_failed"
	| "chunk_parse_failed";
// Classification is total: every property read on an unknown exception is
// guarded, and anything unexpected is "other".
function safeErrorName(error: unknown): string {
	try {
		const name = (error as { name?: unknown } | null | undefined)?.name;
		return typeof name === "string" && SAFE_ERROR_NAMES.has(name)
			? name
			: "other";
	} catch {
		return "other";
	}
}
class ClassifiedFailure extends Error {
	readonly failureClass: FailureClass;
	constructor(failureClass: FailureClass, cause: unknown) {
		super(`${failureClass} (${safeErrorName(cause)})`);
		this.failureClass = failureClass;
	}
}
/** An error whose fixed text is authored here, so it never carries page content. */
class FixedMessageError extends Error {}
const BRIDGE_TIMEOUT_MARK = Symbol("pageshim.bridgeTimeout");
function classifyBridgeFailure(
	error: unknown,
	fallback: FailureClass = "bridge_rejected",
): ClassifiedFailure {
	try {
		if (error instanceof ClassifiedFailure) return error;
		if (
			(error as { [BRIDGE_TIMEOUT_MARK]?: true } | null)?.[BRIDGE_TIMEOUT_MARK]
		)
			return new ClassifiedFailure("bridge_timeout", error);
	} catch {
		// An unreadable exception is still a bridge failure.
	}
	return new ClassifiedFailure(fallback, error);
}

const USER_WAIT_CALLS = new Set<PropertyKey>(["promptUser"]);

export function withBridgeCallTimeout(
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
			let value: unknown;
			try {
				value = Reflect.get(target, property, receiver);
			} catch (error) {
				throw classifyBridgeFailure(error);
			}
			if (typeof value !== "function") return value;
			if (property === "requestedScopes") {
				// Read synchronously, so it is not raced. A host exception is a
				// fixed class, never the raw text.
				return (...args: unknown[]) => {
					try {
						return (value as (...a: unknown[]) => unknown).apply(target, args);
					} catch (error) {
						throw classifyBridgeFailure(error);
					}
				};
			}
			return async (...args: unknown[]) => {
				const started = performance.now();
				let timer: ReturnType<typeof setTimeout> | undefined;
				let result: unknown;
				try {
					if (USER_WAIT_CALLS.has(property)) {
						result = await (value as (...a: unknown[]) => unknown).apply(
							target,
							args,
						);
						return result;
					}
					result = await Promise.race([
						(value as (...a: unknown[]) => unknown).apply(target, args),
						new Promise<never>((_, reject) => {
							timer = setTimeout(
								() =>
									reject(
										Object.assign(
											new Error(
												`PageShim bridge call ${String(property)} timed out after ${timeoutMs}ms`,
											),
											{
												name: "TimeoutError",
												[BRIDGE_TIMEOUT_MARK]: true as const,
											},
										),
									),
								timeoutMs,
							);
						}),
					]);
					return result;
				} catch (error) {
					// Host rejections can echo page or row content, the login wait's
					// included. Report a class only.
					// The wait's class keeps "login" in its text, so the run still reads
					// as an authentication failure.
					throw classifyBridgeFailure(
						error,
						USER_WAIT_CALLS.has(property)
							? "login_wait_failed"
							: "bridge_rejected",
					);
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

// Shells that offer page.input (the thin host) accept the result:begin,
// result:chunk and result:done messages. Older shells take one whole result
// message. A host page can be a Proxy that throws on unknown members, so a
// throw means "absent".
function hostAcceptsStreamedResults(page: ShimPage): boolean {
	try {
		return typeof (page as { input?: unknown }).input === "function";
	} catch {
		return false;
	}
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
				let name = "other";
				try { name = String(error?.name); } catch {}
				return { type: "error", name };
			}
		})()`;
		const response = (await shim.evaluate(wrapped)) as {
			type?: string;
			value?: unknown;
			id?: string;
			length?: number;
			name?: unknown;
		};
		if (response?.type === "undefined") return undefined;
		if (response?.type === "value") return response.value;
		if (response?.type === "too-large") {
			throw new FixedMessageError(
				`PageShim evaluation result is ${response.length} UTF-16 code units; the per-item limit is ${EVALUATE_RESULT_MAX_UNITS}`,
			);
		}
		if (response?.type === "error") {
			throw new ClassifiedFailure("evaluate_failed", { name: response.name });
		}
		if (
			response?.type !== "chunked" ||
			response.id !== id ||
			typeof response.length !== "number" ||
			!Number.isSafeInteger(response.length) ||
			(response.length ?? 0) <= EVALUATE_INLINE_MAX_UNITS ||
			(response.length ?? 0) > EVALUATE_RESULT_MAX_UNITS
		) {
			throw new FixedMessageError(
				"PageShim evaluation returned an invalid transfer marker",
			);
		}

		const length = response.length;
		const readPiece = async (offset: number): Promise<string> => {
			const end = Math.min(offset + EVALUATE_CHUNK_MAX_UNITS, length);
			const piece = await shim.evaluate(
				`globalThis[${JSON.stringify(EVALUATE_RESULT_STORE)}]?.[${JSON.stringify(id)}]?.slice(${offset}, ${end}) ?? null`,
			);
			if (typeof piece !== "string" || piece.length !== end - offset) {
				throw new FixedMessageError(
					"PageShim evaluation chunk exceeded its transfer bound",
				);
			}
			return piece;
		};
		const chunks: string[] = [];
		try {
			// Keep a few slice reads in flight; each read is one bridge round trip.
			for (
				let offset = 0;
				offset < length;
				offset += EVALUATE_CHUNK_MAX_UNITS * EVALUATE_READS_IN_FLIGHT
			) {
				const offsets: number[] = [];
				for (
					let at = offset;
					at < length && offsets.length < EVALUATE_READS_IN_FLIGHT;
					at += EVALUATE_CHUNK_MAX_UNITS
				)
					offsets.push(at);
				chunks.push(...(await Promise.all(offsets.map(readPiece))));
			}
			const json = chunks.join("");
			if (json.length !== response.length) {
				throw new FixedMessageError(
					"PageShim evaluation chunks did not match their declared size",
				);
			}
			try {
				return JSON.parse(json);
			} catch (error) {
				throw new ClassifiedFailure("chunk_parse_failed", error);
			}
		} catch (error) {
			// Our own fixed texts and classified failures pass; a transfer
			// error never quotes the page's text.
			if (
				error instanceof FixedMessageError ||
				error instanceof ClassifiedFailure
			)
				throw error;
			throw classifyBridgeFailure(error);
		} finally {
			// Cleanup only frees page memory; the caller need not wait a round trip.
			void shim
				.evaluate(
					`delete globalThis[${JSON.stringify(EVALUATE_RESULT_STORE)}]?.[${JSON.stringify(id)}]`,
				)
				.catch(() => undefined);
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
	loginUrl: string;
	loginMessage: string;
	validateRecord: Parameters<typeof makeEmitRecord>[0]["validateRecord"];
	probe: (page: ReturnType<typeof playwrightPageFacade>) => Promise<boolean>;
	/** Optional one-time navigation before the first probe; repeated probes must be observational. */
	prepareProbe?: (
		page: ReturnType<typeof playwrightPageFacade>,
	) => Promise<void>;
	/** Runs before makeEmitRecord snapshots per-stream resource selection. */
	prepareRequested?: (
		requested: Parameters<typeof makeEmitRecord>[0]["requested"],
	) => void;
	collect: (ctx: Record<string, unknown>) => Promise<void>;
	/** PDPP records of one stream -> the scope payload the host stores. */
	toScope: (stream: string, records: Rec[]) => unknown;
	/** Generic collectors use successful STATE to acknowledge empty covered ranges. */
	emptyScopeFromCheckpoint?: boolean;
	/** Optional incremental form for connectors whose scope value is one record array. */
	streamScopeRecords?: {
		/** Large streams first; the connector's other streams follow in scope order. Later streams remain buffered until the active scope closes. */
		order: string[];
		/** The scope value's array key, matching `toScope`. Defaults to "records". */
		arrayKey?: string;
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
}

class FatalRunError extends Error {
	readonly telemetryError: ConnectorError;
	constructor(telemetryError: ConnectorError) {
		super(telemetryError.reason);
		this.telemetryError = telemetryError;
	}
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

/**
 * The policy the build captured from the connector's own runConnector call.
 * Every key written in source must resolve to a defined value in the bundle:
 * an undefined retry pattern, normalizer, record key or tombstone would
 * silently disable that policy. A bundle with no capture at all (a test entry
 * that never loads a connector) has no policy.
 */
function capturedConnectorPolicy(): Partial<RunConnectorConfig> | undefined {
	const captured = globalThis as {
		__pageshimConnectorConfig?: unknown;
		__pageshimConnectorConfigKeys?: unknown;
	};
	const keys = captured.__pageshimConnectorConfigKeys;
	const policy = captured.__pageshimConnectorConfig;
	if (keys === undefined && policy === undefined) return undefined;
	if (!Array.isArray(keys) || typeof policy !== "object" || policy === null)
		throw new Error("PageShim connector policy was not captured as an object");
	for (const key of keys) {
		if ((policy as Record<string, unknown>)[String(key)] === undefined)
			throw new Error(
				`PageShim connector policy ${String(key)} resolved to undefined`,
			);
	}
	return policy as Partial<RunConnectorConfig>;
}

/** JSON.stringify whose failure reports a class, never the row-bearing message. */
function stringifyRow(value: unknown): string | undefined {
	try {
		return JSON.stringify(value);
	} catch (error) {
		throw new ClassifiedFailure("serialize_failed", error);
	}
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
	const scopeByStream = new Map(
		connector.scopes
			.filter((scope) => scope.startsWith(prefix))
			.map((scope) => [scope.slice(prefix.length), scope]),
	);
	const requested = new Map<string, StreamScope>(
		requestedScopes
			.filter((s) => s.startsWith(prefix))
			.map((s) => [
				s.slice(prefix.length),
				{
					name: s.slice(prefix.length),
				},
			]),
	);
	if (!initError && connector.prepareRequested) {
		try {
			connector.prepareRequested(requested);
		} catch (error) {
			initError = error;
		}
	}
	const records: Record<string, Rec[]> = {};
	const state: Record<string, unknown> = {};
	for (const [stream, scope] of scopeByStream)
		if (Object.hasOwn(initialState, scope)) state[stream] = initialState[scope];
	const outcome = new CollectionOutcome(prefix, requested.keys());
	const streamedStreams = new Set<string>();
	// A thin host accepts streamed results only (mobile-host-v1 amendment A6).
	const streamingHost = hostAcceptsStreamedResults(pageShim);
	let rawEndHost = false;
	try {
		rawEndHost =
			(pageShim as ShimPage & { capabilities?: () => string[] })
				.capabilities?.()
				.includes("connector-end-evidence/1") === true;
	} catch {
		/* Older hosts throw on unknown optional members. */
	}
	const streamConfig =
		connector.streamScopeRecords && streamingHost
			? connector.streamScopeRecords
			: null;
	const streamOrder = streamConfig
		? [
				...streamConfig.order,
				...[...scopeByStream.keys()].filter(
					(stream) => !streamConfig.order.includes(stream),
				),
			]
		: [];
	const pendingRecords: Record<string, Rec[]> = {};
	const streamCounts = outcome.counts;
	let streamProtocolUsed = false;
	let legacyResultAccepted = false;
	let activeStream: string | null = null;
	let activeSequence = 0;
	let activeRecordCount = 0;
	let activeChunkConversationIds = new Set<string>();
	// Record text waiting for a full chunk. One bridge message per record made
	// a large ChatGPT run cost two host round trips per message record.
	let pendingStreamText = "";
	let pendingChunkSpans: { id: string; start: number; end: number }[] = [];
	let streamedScopeCount = 0;
	let streamFailure: Error | null = null;
	let streamSendFailed = false;
	const conversationTimings = new Map<
		string,
		{
			providerFetchMs: number;
			jsProcessMs: number;
			bridgeMs: number;
			bridgeCalls: string[];
			bridgeCallsOmitted: number;
			processed: boolean;
			completed: boolean;
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
				bridgeCallsOmitted: 0,
				processed: false,
				completed: false,
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
		if (timing) {
			timing.jsProcessMs += processingMs;
			timing.processed = true;
		}
	};
	(globalThis as Record<string, unknown>).__pdppPageshimSetTimingConversation =
		(conversationIds: string[] | null) => {
			if (
				conversationIds === null &&
				activeTimingConversationIds.length === 1
			) {
				const timing = conversationTimings.get(activeTimingConversationIds[0]);
				if (timing?.processed) timing.completed = true;
			}
			activeTimingConversationIds = conversationIds ?? [];
			if (conversationIds === null) finishCompletedTimings();
			for (const id of activeTimingConversationIds) {
				if (!conversationTimings.has(id)) {
					conversationTimings.set(id, {
						providerFetchMs: 0,
						jsProcessMs: 0,
						bridgeMs: 0,
						bridgeCalls: [],
						bridgeCallsOmitted: 0,
						processed: false,
						completed: false,
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
			if (timing.bridgeCalls.length < MAX_TIMING_BRIDGE_CALLS) {
				timing.bridgeCalls.push(
					`${label}:${elapsedMs.toFixed(1)}ms/${requestBytes}+${responseBytes}B`,
				);
			} else timing.bridgeCallsOmitted++;
			timing.bridgeBytes += requestBytes + responseBytes;
		}
	};
	const sendStreamMessage = async (
		key: string,
		value: unknown,
	): Promise<void> => {
		try {
			if (
				JSON.stringify(["setData", [key, value]]).length > PAGE_BRIDGE_MAX_UNITS
			)
				throw new Error("PageShim result metadata exceeds the bridge limit");
			await shim.setData(key, value);
		} catch (error) {
			streamSendFailed = true;
			streamFailure = classifyBridgeFailure(error);
			throw streamFailure;
		}
	};
	const sendStreamText = async (
		scope: string,
		text: string,
		spans: typeof pendingChunkSpans = [],
	): Promise<void> => {
		for (let offset = 0; offset < text.length; ) {
			let end = Math.min(offset + RESULT_CHUNK_MAX_UNITS, text.length);
			if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end--;
			const piece = text.slice(offset, end);
			activeChunkConversationIds = new Set(
				spans
					.filter((span) => span.start < end && span.end > offset)
					.map((span) => span.id),
			);
			await sendStreamMessage("result:chunk", {
				scope,
				sequence: activeSequence,
				text: piece,
			});
			activeSequence++;
			offset = end;
		}
	};
	// Send buffered record text: only whole chunks unless `all` is set.
	// Flushes run one at a time so chunk text keeps its order.
	let streamFlushChain: Promise<void> = Promise.resolve();
	const flushStreamText = (all: boolean): Promise<void> => {
		const run = streamFlushChain.then(() => flushStreamTextNow(all));
		streamFlushChain = run.catch(() => undefined);
		return run;
	};
	const flushStreamTextNow = async (all: boolean): Promise<void> => {
		if (activeStream === null) return;
		const scope = `${prefix}${activeStream}`;
		let end = all
			? pendingStreamText.length
			: pendingStreamText.length -
				(pendingStreamText.length % RESULT_CHUNK_MAX_UNITS);
		if (end === 0) return;
		if (
			end < pendingStreamText.length &&
			isHighSurrogate(pendingStreamText.charCodeAt(end - 1))
		)
			end--;
		const text = pendingStreamText.slice(0, end);
		pendingStreamText = pendingStreamText.slice(end);
		const spans = pendingChunkSpans;
		pendingChunkSpans = spans
			.filter((span) => span.end > end)
			.map((span) => ({
				...span,
				start: Math.max(0, span.start - end),
				end: span.end - end,
			}));
		try {
			await sendStreamText(scope, text, spans);
		} finally {
			activeChunkConversationIds.clear();
			finishCompletedTimings();
		}
	};
	const beginStreamScope = async (stream: string): Promise<void> => {
		const scope = `${prefix}${stream}`;
		streamProtocolUsed = true;
		await sendStreamMessage("result:begin", { scope });
		streamedStreams.add(stream);
		activeStream = stream;
		activeSequence = 0;
		activeRecordCount = 0;
		activeChunkConversationIds = new Set();
		pendingStreamText = `{${JSON.stringify(rawEndHost ? "records" : (streamConfig?.arrayKey ?? "records"))}:[`;
		pendingChunkSpans = [];
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
					pendingChunkSpans.push({
						id: conversationId,
						start: pendingStreamText.length,
						end:
							pendingStreamText.length +
							serialized.length +
							(activeRecordCount > 0 ? 1 : 0),
					});
				}
			}
			pendingStreamText +=
				activeRecordCount > 0 ? `,${serialized}` : serialized;
			activeRecordCount++;
			if (pendingStreamText.length >= RESULT_CHUNK_MAX_UNITS)
				await flushStreamText(false);
		} catch (error) {
			streamFailure =
				error instanceof ClassifiedFailure
					? error
					: new ClassifiedFailure("serialize_failed", error);
			throw streamFailure;
		}
	};
	let timingOrdinal = 0;
	const finishCompletedTimings = (all = false): void => {
		const pending = new Set(pendingChunkSpans.map((span) => span.id));
		for (const [id, timing] of conversationTimings) {
			if (
				!all &&
				(!timing.completed ||
					pending.has(id) ||
					activeChunkConversationIds.has(id) ||
					activeTimingConversationIds.includes(id))
			)
				continue;
			timingOrdinal++;
			console.info(
				`[chatgpt-timing] conversation=${timingOrdinal} providerFetchMs=${Math.round(timing.providerFetchMs)} jsProcessMs=${Math.round(timing.jsProcessMs)} bridgeCalls=${timing.bridgeCalls.join("|")} bridgeBytes=${timing.bridgeBytes} bridgeMs=${Math.round(timing.bridgeMs)} bridgeRoundTrips=${timing.roundTrips} shellAckMs=${Math.round(timing.ackMs)} bytes=${timing.bytes} bridgeCallsOmitted=${timing.bridgeCallsOmitted}`,
			);
			conversationTimings.delete(id);
		}
	};
	const finishStreamScope = async (): Promise<void> => {
		if (activeStream === null) return;
		const scope = `${prefix}${activeStream}`;
		pendingStreamText += "]}";
		await flushStreamText(true);
		await sendStreamMessage("result:scope-done", {
			scope,
			chunkCount: activeSequence,
		});
		if (activeStream === "messages") finishCompletedTimings(true);
		streamedScopeCount++;
		activeStream = null;
	};
	const isHighSurrogate = (unit: number): boolean =>
		unit >= 0xd800 && unit <= 0xdbff;
	// One record marker per nonempty interval between coverage reports has
	// the same ordering evidence as one per record, without a bridge round trip
	// for every stored row. Record bodies still all go to the durable spool.
	const recordMarkerStreams = new Set<string>();
	const unsupportedStreams = new Set<string>();
	const lifecycle: { failure?: TerminalError; done?: Msg } = {};
	const publishDone = async (): Promise<void> => {
		const done = lifecycle.done;
		if (!done) return;
		lifecycle.done = undefined;
		// Contract: DONE reaches connector:message before result:done, and a
		// later result:done rejection or missing acknowledgement cannot retract
		// it. The host MUST refuse a spool that lacks result:done, even after it
		// has seen a succeeded DONE. Every scope's result:scope-done is awaited
		// (and so acknowledged) before this DONE is published.
		// Second contract, the same kind: the lifecycle's output channel seals
		// before DONE, so nothing new starts after it. A transport write that
		// already started, and hangs past the settlement deadline, cannot be
		// recalled. The host MUST discard any frame that arrives after DONE.
		await shim.setData("connector:message", done);
	};
	const emitMessage = async (msg: Msg): Promise<void> => {
		if (msg.type !== "DONE" && streamFailure) throw streamFailure;
		if (msg.type === "RECORD") {
			const stream = String(msg.stream);
			if (!recordMarkerStreams.has(stream)) {
				recordMarkerStreams.add(stream);
				await shim.setData("connector:message", {
					type: "RECORD",
					stream: msg.stream,
				});
			}
		} else if (
			[
				"SKIP_RESULT",
				"DETAIL_COVERAGE",
				"DETAIL_GAP",
				"DETAIL_GAP_RECOVERED",
				"WHOLE_STREAM_EVIDENCE",
				"PREFLIGHT_EXCLUDED",
			].includes(msg.type)
		) {
			if (msg.type === "DETAIL_COVERAGE")
				recordMarkerStreams.delete(String(msg.stream));
			await shim.setData("connector:message", msg);
		}
		switch (msg.type) {
			case "RECORD": {
				const stream = String(msg.stream);
				const record =
					msg.op === "delete"
						? {
								key: msg.key,
								data: msg.data,
								op: msg.op,
								emitted_at: msg.emitted_at,
							}
						: (msg.data as Rec);
				outcome.record(stream);
				if (streamConfig) {
					const target = streamOrder[0];
					if (!streamOrder.includes(stream))
						throw new Error(`PageShim stream serializer missing ${stream}`);
					if (stream === target) {
						if (activeStream === null) await beginStreamScope(stream);
						await appendStreamRecord(stream, record);
					} else {
						pendingRecords[stream] ??= [];
						pendingRecords[stream].push(record);
					}
				} else {
					records[stream] ??= [];
					records[stream].push(record);
				}
				return;
			}
			case "STATE": {
				const stream = String(msg.stream);
				const scope = scopeByStream.get(stream);
				if (!scope) throw new Error(`unsupported STATE stream: ${stream}`);
				// Retain candidates until every late coverage veto has settled.
				outcome.checkpoint(stream, msg.cursor);
				state[stream] = msg.cursor;
				return;
			}
			case "SKIP_RESULT":
				if (msg.reason === "scope_not_supported")
					unsupportedStreams.add(String(msg.stream));
				outcome.skip(msg);
				return;
			case "DETAIL_COVERAGE":
				outcome.coverage(msg);
				return;
			case "DETAIL_GAP":
				outcome.detailGap(String(msg.stream));
				return;
			case "PROGRESS":
				await shim.setProgress({
					phase: { label: String(msg.stream ?? "collect") },
					message: String(msg.message ?? "").slice(0, ERROR_TEXT_MAX_UNITS),
					count: msg.count,
				});
				return;
			case "DONE":
				// An emission can still land between the end of settlement and
				// this DONE; it is not in the result, so the run cannot succeed.
				if (msg.status === "succeeded" && lateEmission) {
					msg = {
						type: "DONE",
						status: "failed",
						records_emitted: msg.records_emitted,
						error: {
							message: lateEmission.message,
							code: "emission_after_settlement",
							retryable: false,
						},
					};
				}
				// Keep the lifecycle's terminal value unchanged. Publish it after
				// candidate STATE writes settle, before closing the result spool.
				lifecycle.done = msg;
				if (msg.status === "failed") {
					const error = msg.error as TerminalErrorDetails | undefined;
					lifecycle.failure = new TerminalError(
						error?.message ?? "Connector collection failed",
						{
							code: error?.code,
							retryable: error?.retryable,
							recoveryHint: error?.recovery_hint,
						},
					);
				}
				return;
			default:
				console.log(`pageshim: PDPP message ${msg.type} ignored`);
		}
	};
	const pendingStateWrites = new Set<Promise<void>>();
	let stateWriteFailure: Error | null = null;
	// Serialize transport effects in protocol invocation order, including
	// concurrent/unawaited emits. A rejected write cannot be swallowed into
	// terminal success by a collector that isolates individual record errors.
	let messageChain: Promise<void> = Promise.resolve();
	// Settlement builds the finalized coverage view and the result payload from
	// what was admitted so far. Once it starts, only its own emissions and the
	// terminal DONE may enter; anything else would miss that view.
	let settlementSealed = false;
	let lateEmission: Error | null = null;
	const admit = (msg: Msg, internal: boolean): Promise<void> | null => {
		if (!settlementSealed || internal || msg.type === "DONE") return null;
		lateEmission ??= new Error(
			`PageShim ${msg.type} emitted after settlement began`,
		);
		return Promise.reject(lateEmission);
	};
	const emit = (msg: Msg, internal = false): Promise<void> => {
		const rejected = admit(msg, internal);
		if (rejected) return rejected;
		const pending = messageChain.then(() => emitMessage(msg));
		messageChain = pending.catch((error: unknown) => {
			streamFailure ??=
				error instanceof Error ? error : new Error(String(error));
		});
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

	let completeResult: (() => Promise<void>) | undefined;
	const settleResult = async (
		withheldAtOrAfterUntil: ReadonlySet<string>,
	): Promise<void> => {
		settlementSealed = true;
		await messageChain;
		// Some entry adapters attach host bounds during collect. Preserve their
		// unsupported-scope diagnostics after those mutations, without repeating
		// diagnostics already emitted by the shared lifecycle's preflight.
		const timeRangeFieldFor = consentTimeFieldResolver(
			typeof PAGESHIM_CONNECTOR_MANIFEST === "string"
				? PAGESHIM_CONNECTOR_MANIFEST
				: connector.platform,
		);
		for (const [stream, scope] of requested) {
			if (unsupportedStreams.has(stream)) continue;
			const unsupported = timeRangeUnsupportedReason(
				stream,
				scope.time_range,
				timeRangeFieldFor(stream),
			);
			if (unsupported !== null)
				await emit(
					{
						type: "SKIP_RESULT",
						stream,
						reason: "scope_not_supported",
						message: unsupported,
					},
					true,
				);
		}
		const finalized = outcome.finalize(
			new Set(
				[...requested]
					.filter(
						([, scope]) =>
							(scope as { time_range?: unknown }).time_range !== undefined,
					)
					.map(([stream]) => stream),
			),
			withheldAtOrAfterUntil,
		);
		const errors = finalized.errors;
		const outcomesByStream = new Map(
			finalized.streams.map((stream) => [stream.stream, stream]),
		);
		const completionStatus = (summary: { count: number; label: string }) =>
			`${finalized.partial ? "Partial:" : "Complete!"} ${summary.count} ${summary.label}`;
		const flushCheckpoints = async (): Promise<void> => {
			if (!supportsState) return;
			for (const stream of finalized.streams) {
				if (stream.checkpoint !== undefined)
					await shim.setData("STATE", {
						type: "STATE",
						stream: stream.scope,
						cursor: stream.checkpoint.cursor,
					});
			}
		};
		if (streamFailure) throw streamFailure;
		if (lateEmission) throw lateEmission;
		if (streamConfig) {
			await finishStreamScope();
			for (const stream of streamOrder) {
				const buffered = pendingRecords[stream] ?? [];
				// A confirmed-empty stream still sends its scope, empty, so the
				// host can tell "collected, none" from "not collected". A
				// windowed stream is not: no rows in the window says nothing
				// about older ones.
				const confirmedEmpty =
					outcomesByStream.get(stream)?.confirmedEmptyInventory === true &&
					!streamedStreams.has(stream);
				if (buffered.length === 0 && !confirmedEmpty) continue;
				await beginStreamScope(stream);
				for (const record of buffered) await appendStreamRecord(stream, record);
				await finishStreamScope();
			}
			if (streamedScopeCount > 0) {
				await flushCheckpoints();
				const exportSummary = streamConfig.summarizeCounts(streamCounts);
				completeResult = async () => {
					await sendStreamMessage("result:done", {
						scopeCount: streamedScopeCount,
						exportSummary,
						errors,
					});
					await shim.setData("status", completionStatus(exportSummary));
				};
				return;
			}
		}
		const scopes: Record<string, unknown> = {};
		for (const [stream, recs] of Object.entries(records))
			scopes[`${prefix}${stream}`] = connector.toScope(stream, recs);
		// A successful checkpoint proves coverage of this window, even when no
		// rows exist in it. An empty scope is only this run's payload; requested
		// bounds and deferred/partial errors still describe its coverage.
		for (const stream of finalized.streams) {
			if (connector.emptyScopeFromCheckpoint && stream.emptyFromCheckpoint)
				scopes[stream.scope] ??= connector.toScope(stream.stream, []);
		}
		// An omitted scope still carries its incomplete outcome on thin hosts.
		if (streamingHost && Object.keys(scopes).length === 0) {
			for (const stream of finalized.streams) {
				if (stream.partial)
					scopes[stream.scope] = connector.toScope(stream.stream, []);
			}
		}
		if (streamingHost) {
			// The host rejects a stream without scopes, so a run that collected
			// nothing reports its reason as a run error instead.
			// Thin hosts batch records, not presentation envelopes. Store exactly
			// one entry for each native RECORD; legacy envelopes can expand one
			// RECORD into several rows and make DONE's count disagree.
			const scopeEntries = rawEndHost
				? Object.keys(scopes).map(
						(scope) =>
							[
								scope,
								{ records: records[scope.slice(prefix.length)] ?? [] },
							] as const,
					)
				: Object.entries(scopes);
			if (scopeEntries.length === 0)
				throw new Error(errors[0]?.reason ?? "no records collected");
			for (const [scope, value] of scopeEntries) {
				const text = stringifyRow(value);
				if (text === undefined)
					throw new Error(`PageShim scope ${scope} could not be serialized`);
				streamProtocolUsed = true;
				await sendStreamMessage("result:begin", { scope });
				activeSequence = 0;
				await sendStreamText(scope, text);
				await sendStreamMessage("result:scope-done", {
					scope,
					chunkCount: activeSequence,
				});
			}
			await flushCheckpoints();
			const exportSummary = connector.summarize(scopes);
			completeResult = async () => {
				await sendStreamMessage("result:done", {
					scopeCount: scopeEntries.length,
					exportSummary,
					errors,
				});
				await shim.setData("status", completionStatus(exportSummary));
			};
			return;
		}
		const done = result(scopes, errors);
		const serialized = stringifyRow(done);
		if (serialized.length > RESULT_CHUNK_MAX_UNITS) {
			throw new Error(
				`PageShim result exceeds the ${RESULT_CHUNK_MAX_UNITS}-unit legacy bridge limit; this host does not accept streamed results`,
			);
		}
		await shim.setData("result", done);
		legacyResultAccepted = true;
		await flushCheckpoints();
		completeResult = async () => {
			await shim.setData("status", completionStatus(done.exportSummary));
		};
	};

	try {
		// A bad capture reports through the lifecycle's own failed DONE, like
		// any other start-up failure.
		let policy: Partial<RunConnectorConfig> | undefined;
		try {
			policy = capturedConnectorPolicy();
		} catch (error) {
			initError ??= error;
		}
		const { exitCode } = await runConnectorLifecycle(
			{
				name:
					typeof PAGESHIM_CONNECTOR_MANIFEST === "string"
						? PAGESHIM_CONNECTOR_MANIFEST
						: connector.platform,
				retryablePattern: policy?.retryablePattern,
				normalizeTerminalError: policy?.normalizeTerminalError,
				recordKeyFields: policy?.recordKeyFields,
				isTombstone: policy?.isTombstone,
				validateRecord: connector.validateRecord,
				collect: async (ctx) => {
					await shim.setData(
						"status",
						`Checking ${connector.platform} login...`,
					);
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
					await connector.collect({ ...ctx, page });
					await settleStateWrites();
				},
			},
			{
				beforeDone: settleResult,
				readStart: async () => {
					if (initError) throw initError;
					return {
						type: "START",
						scope: { streams: [...requested.values()] },
						state,
					};
				},
				emit: (message: EmittedMessage) => emit(message as Msg),
				sendInteraction: async () => {
					throw new Error("PageShim interaction is not supported");
				},
				// This host supplies no detail-gap recovery inventory.
				requestDetailGapPage: async () => [],
			},
		);
		// A reported stream failure still closes the partial spool; its failed
		// DONE remains authoritative. A thrown collection/login error keeps the
		// existing fatal transport path.
		if (
			(exitCode !== 0 || lifecycle.failure) &&
			lifecycle.failure?.code !== "stream_collection_failed"
		)
			throw (
				initError ??
				lifecycle.failure ??
				new Error("Connector collection failed")
			);
		await publishDone();
		await completeResult?.();
	} catch (error) {
		const reason = (
			error instanceof Error ? error.message : String(error)
		).slice(0, ERROR_TEXT_MAX_UNITS);
		const fatal =
			error instanceof FatalRunError
				? error.telemetryError
				: fatalCollectionError(error, reason);
		// Keep the records collected before the failure in the host's partial
		// result, as when every record was sent on its own.
		if (!streamSendFailed) await flushStreamText(true).catch(() => undefined);
		// A legacy payload can already back committed checkpoints. Preserve it
		// after a later STATE or status failure, reporting the error separately.
		// Only a run with no accepted payload may emit an empty fatal result.
		if (!streamProtocolUsed && !streamingHost && !legacyResultAccepted)
			await shim.setData("result", result({}, [fatal]));
		await publishDone();
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
