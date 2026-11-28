// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Readiness checks for `conformance <connector>`: the things a reviewer
 * otherwise has to find by reading the code.
 *
 * Every function here is pure. It takes the manifest, the connector's source
 * text and a few facts gathered by `conformance.ts`, and returns one step.
 * Nothing here reads the file system, so each rule is pinned by a unit test.
 *
 * Each step says what is missing and what to do. No step claims that a
 * connector works against a real account; only a recorded real run
 * (the `evidence` step) speaks to that.
 */

export type Verdict = "PASS" | "FAIL" | "UNKNOWN" | "ADVISORY" | "WEAK";

export interface Step {
	readonly advisory?: boolean;
	readonly detail: string;
	readonly name: string;
	/** A trial could not establish its result. A no-HTTP claim cannot exempt it. */
	readonly mockMutationInconclusive?: boolean;
	/** The specific command or edit that moves this step off its current verdict. Absent only for PASS. */
	readonly nextAction?: string;
	readonly verdict: Verdict;
}

/** Checklist requirements; old no-claim promotions keep their disclosed gaps. */
export function requiredForReview(
	step: Step,
	context: {
		readonly isKnownScaffold: boolean;
		readonly promotedTier: boolean;
		readonly legacyPromotion: boolean;
		readonly noHttpExemption: boolean;
	},
): boolean {
	if (!step.advisory && step.verdict === "FAIL") {
		return true;
	}
	if (
		[
			"submission refresh",
			"submission deletions",
			"submission text",
			"submission counts",
		].includes(step.name)
	) {
		return !step.advisory;
	}
	if (["manifest", "tests"].includes(step.name)) {
		return true;
	}
	if (step.name === "coverage") {
		return !context.isKnownScaffold;
	}
	if (!context.promotedTier || context.legacyPromotion) {
		return false;
	}
	return (
		["evidence", "pilot fixture"].includes(step.name) ||
		(step.name === "mock mutation" &&
			!(
				step.verdict === "UNKNOWN" &&
				context.noHttpExemption &&
				!step.mockMutationInconclusive
			))
	);
}

/** The bounded pilot covers required network bindings without other binding kinds. */
export function isApiSubmissionPilot(manifest: unknown): boolean {
	if (
		!manifest ||
		typeof manifest !== "object" ||
		!("runtime_requirements" in manifest)
	)
		return false;
	const runtime = manifest.runtime_requirements;
	if (!runtime || typeof runtime !== "object" || !("bindings" in runtime))
		return false;
	const bindings = runtime.bindings;
	if (!bindings || typeof bindings !== "object" || Array.isArray(bindings))
		return false;
	const entries = Object.entries(bindings);
	return (
		entries.some(
			([key, binding]) =>
				binding &&
				typeof binding === "object" &&
				(binding.kind ?? key) === "network" &&
				binding.required === true,
		) &&
		entries.every(
			([key, binding]) =>
				binding &&
				typeof binding === "object" &&
				!Array.isArray(binding) &&
				typeof binding.required === "boolean" &&
				(binding.kind === undefined || typeof binding.kind === "string") &&
				(binding.kind ?? key) === "network",
		)
	);
}

/** A disclosed author assertion in entrypoint comments, not an HTTP analysis. */
export function declaredNoHttpExemption(source: string): string | undefined {
	const header =
		source.match(
			/^(?:#![^\n]*(?:\n|$))?\s*(?:(?:\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)\s*)*/,
		)?.[0] ?? "";
	const reason = header
		.match(
			/(?:^|\n)[\t ]*(?:\*|\/\/|\/\*)[\t ]*@conformance-no-http[\t ]+([^\r\n]+)/,
		)?.[1]
		?.replace(/\*\/\s*$/, "")
		.trim();
	return reason || undefined;
}

interface SchemaProperty {
	readonly description?: unknown;
	readonly format?: unknown;
	readonly type?: unknown;
}

export interface ManifestStream {
	readonly consent_time_field?: unknown;
	readonly coverage_strategy?: unknown;
	readonly cursor_field?: unknown;
	readonly incremental?: unknown;
	readonly name?: unknown;
	readonly query?: { readonly aggregations?: unknown };
	readonly relationships?: unknown;
	readonly required?: unknown;
	readonly schema?: { readonly properties?: Record<string, SchemaProperty> };
}

export interface ReadinessManifest {
	readonly reason_display_messages?: unknown;
	readonly runtime_requirements?: {
		readonly bindings?: { readonly browser?: unknown };
	};
	readonly streams?: readonly ManifestStream[];
	readonly version?: unknown;
}

/** The coverage strategies that the shared coverage oracle requires a run to prove. */
const PROOF_STRATEGIES: ReadonlySet<string> = new Set([
	"checkpoint_window",
	"full_inventory",
	"parent_detail_accounting",
	"snapshot_import_receipt",
	"singleton_presence",
]);

const COVERAGE_RATCHET =
	"connectors/_conformance/coverage-conformance-drivers.ts";

/** The manifest's stream entries that are objects; `checkManifest` reports the rest. */
function streamsOf(manifest: ReadinessManifest): ManifestStream[] {
	return Array.isArray(manifest.streams)
		? manifest.streams.filter(
				(s): s is ManifestStream => typeof s === "object" && s !== null,
			)
		: [];
}

function streamName(stream: ManifestStream): string {
	return typeof stream.name === "string" ? stream.name : "(unnamed)";
}

/** Streams that declare a coverage strategy the shared oracle asks a run to prove. */
function proofStreams(manifest: ReadinessManifest): ManifestStream[] {
	return streamsOf(manifest).filter(
		(s) =>
			typeof s.coverage_strategy === "string" &&
			PROOF_STRATEGIES.has(s.coverage_strategy),
	);
}

/**
 * Source text without comments, so a comment such as `// TODO emit
 * DETAIL_COVERAGE` neither satisfies nor triggers a rule. String and template
 * literals are kept whole, so `"*\/*"` or `"//api"` never starts a comment.
 * Regex literals are not parsed; a `/` after a backslash never starts one.
 */
export function stripComments(source: string): string {
	let out = "";
	let i = 0;
	while (i < source.length) {
		const c = source[i];
		const next = source[i + 1];
		if (c === '"' || c === "'" || c === "`") {
			const start = i;
			for (i += 1; i < source.length && source[i] !== c; i += 1) {
				if (source[i] === "\\") i += 1;
				else if (c !== "`" && source[i] === "\n") break;
			}
			i += 1;
			out += source.slice(start, i);
		} else if (c === "/" && source[i - 1] !== "\\" && next === "/") {
			const end = source.indexOf("\n", i);
			i = end === -1 ? source.length : end;
		} else if (c === "/" && source[i - 1] !== "\\" && next === "*") {
			const end = source.indexOf("*/", i + 2);
			i = end === -1 ? source.length : end + 2;
		} else {
			out += c;
			i += 1;
		}
	}
	return out;
}

// ─── evidence: is a recorded claim bound to this exact code? ──────────────

export type EvidenceStatus = "bound" | "malformed" | "none" | "stale";

const RECORD_COMMANDS =
	"record a run against your own account and commit the claim: `node --import tsx packages/polyfill-connectors/bin/scenario-record.ts <key>`, then `node --import tsx packages/polyfill-connectors/bin/scenario-verify.ts <key> <scenario-path> --json connectors/<key>/evidence/claim.json` (AUTHORING.md steps 5-7). Commit only claim.json; the scenario can hold your data.";

export function checkEvidence(
	connector: string,
	status: EvidenceStatus,
	detail: {
		claim?: string | undefined;
		malformedError?: string | undefined;
		notEstablished?: readonly string[] | undefined;
	} = {},
): Step {
	const { claim, malformedError, notEstablished = [] } = detail;
	const commands = RECORD_COMMANDS.replaceAll("<key>", connector);
	switch (status) {
		case "bound":
			return {
				detail: `evidence/claim.json (${claim ?? "unknown claim"}) is bound to this exact source and manifest. CI does not re-run it.${notEstablished.length > 0 ? ` It does not establish: ${notEstablished.join("; ")}.` : ""}`,
				name: "evidence",
				verdict: "PASS",
			};
		case "stale":
			return {
				detail:
					"evidence/claim.json was recorded from older source or manifest; it does not describe this code",
				name: "evidence",
				nextAction: `record the run again after your last change: ${commands}`,
				verdict: "WEAK",
			};
		case "malformed":
			return {
				detail: `evidence/claim.json does not parse: ${malformedError ?? "unknown error"}`,
				name: "evidence",
				nextAction: `regenerate it rather than editing it by hand: ${commands}`,
				verdict: "FAIL",
			};
		default:
			return {
				detail:
					"no evidence/claim.json — nothing shows this connector ran against a real account. Reviewers usually cannot run it themselves.",
				name: "evidence",
				nextAction: commands,
				verdict: "UNKNOWN",
			};
	}
}

// ─── coverage: will a successful run prove what the manifest declares? ────

/**
 * Source text that reports coverage: a DETAIL_COVERAGE message, built
 * directly or through a shared build*Coverage / emit*Coverage helper, or a
 * receipt on a `coverage_diagnostics` stream (file imports such as
 * apple_health).
 */
const COVERAGE_EMISSION =
	/DETAIL_COVERAGE|coverage_diagnostics|\b(?:build|emit)\w*Coverage\w*\s*\(/;

export function checkCoverageProof(
	connector: string,
	manifest: ReadinessManifest,
	source: string,
	registry: CoverageRegistry,
): Step {
	const streams = proofStreams(manifest);
	if (streams.length === 0) {
		return {
			detail: "no stream declares a coverage strategy",
			name: "coverage",
			verdict: "PASS",
		};
	}
	if (!COVERAGE_EMISSION.test(stripComments(source))) {
		return {
			detail: `${streams.length} stream(s) declare a coverage strategy, but the source never reports coverage (no DETAIL_COVERAGE, coverage helper or coverage_diagnostics receipt). Unless a shared runtime reports it for you, a successful run reads as "coverage not measured".`,
			name: "coverage",
			nextAction:
				"after a complete pass over a stream, emit its DETAIL_COVERAGE with buildFullScanCoverageMessage, buildDetailCoverageMessage or emitDetailCoverage (packages/polyfill-connectors/src/connector-runtime.ts). considered = items the source listed; covered = items emitted. A shortfall is reported this way, not by failing the run.",
			verdict: "UNKNOWN",
		};
	}
	// The oracle gate checks required streams only.
	const required = streams.filter((s) => s.required !== false).map(streamName);
	const exempt = required.filter((name) =>
		registry.unexercised.has(`${connector}.${name}`),
	);
	const addDriver = `add a driver for ${connector} in ${COVERAGE_RATCHET} (copy an in-process driver such as YNAB's) and remove any KNOWN_UNEXERCISED_COVERAGE entries for it; connectors/_conformance/coverage-conformance.test.ts then proves each stream`;
	if (exempt.length > 0) {
		return {
			detail: `${exempt.join(", ")} listed in KNOWN_UNEXERCISED_COVERAGE: no test runs this connector through the shared coverage oracle`,
			name: "coverage",
			nextAction: addDriver,
			verdict: "UNKNOWN",
		};
	}
	if (required.length > 0 && !registry.drivers.has(connector)) {
		return {
			detail: `no coverage driver for ${connector}: no test runs it through the shared coverage oracle, and the coverage ratchet in npm test fails for ${required.join(", ")}`,
			name: "coverage",
			nextAction: addDriver,
			verdict: "UNKNOWN",
		};
	}
	return {
		detail: `${streams.length} stream(s) declare a coverage strategy; the source reports coverage, and a coverage driver runs every required one through the shared coverage oracle`,
		name: "coverage",
		verdict: "PASS",
	};
}

// ─── version: a new connector starts at 0.1.0 ─────────────────────────────

/**
 * `baseVersion` is the manifest version on the base branch: `null` when the
 * connector does not exist there (a new connector), `undefined` when the
 * base could not be read (no git, no base ref).
 */
export function checkVersion(
	manifest: ReadinessManifest,
	baseVersion: string | null | undefined,
): Step | null {
	if (baseVersion !== null) return null;
	const version = typeof manifest.version === "string" ? manifest.version : "";
	if (version === "0.1.0") {
		return {
			advisory: true,
			detail: "new connector at 0.1.0",
			name: "version",
			verdict: "PASS",
		};
	}
	return {
		advisory: true,
		detail: `new connector declares version "${version}"`,
		name: "version",
		nextAction:
			'set "version": "0.1.0". Before 1.0.0 the minor version marks breaking changes; a maintainer promotes a connector to 1.0.0 after it works well in production (packages/polyfill-connectors/docs/connector-authoring-guide.md, "Versioning and drift"). If you believe it is ready for 1.0.0 now, say why in the PR.',
		verdict: "WEAK",
	};
}

// ─── shared helpers: use what the package already provides ─────────────────

export interface SharedHelperRule {
	/** "api": only connectors that need no browser binding; "all": every connector. */
	readonly appliesTo: "all" | "api";
	/** Source that shows the connector does this job itself. */
	readonly handRolled: RegExp;
	readonly id: string;
	readonly message: string;
	/** Source that shows the connector already uses the shared helper. */
	readonly usesShared: RegExp;
}

/**
 * One row per job the shared package already does well. Add a row whenever
 * a practice is extracted from a good connector into
 * packages/polyfill-connectors, so every later connector is checked for it.
 */
export const SHARED_HELPER_RULES: readonly SharedHelperRule[] = [
	{
		appliesTo: "api",
		handRolled: /\b429\b|retry-after/i,
		id: "http-governor",
		message:
			"handles HTTP rate limits itself. Use createConnectorHttpGovernor (packages/polyfill-connectors/src/connector-http-governor.ts) with the provider's documented limits: it paces requests, backs off on 429 and 5xx, honours Retry-After and raises an error the runtime can retry later. If you cannot use it, at least parse Retry-After with parseRetryAfterMs from @pdpp/connector-protocol/http-retry.",
		usesShared: /createConnectorHttpGovernor/,
	},
	{
		appliesTo: "all",
		handRolled: /type:\s*["']DETAIL_COVERAGE["']/,
		id: "coverage-message",
		message:
			"builds DETAIL_COVERAGE messages by hand. Use buildFullScanCoverageMessage or buildDetailCoverageMessage (packages/polyfill-connectors/src/connector-runtime.ts).",
		usesShared: /build(?:FullScan|Detail)CoverageMessage/,
	},
];

/**
 * A thrown error that names a rate limit or carries an HTTP status. The
 * runtime retries a failed run later only when `retryablePattern` matches the
 * error message; its default (/ECONN|ETIMEDOUT|timeout/i) matches neither.
 */
const RETRYABLE_ERROR_THROWN =
	/throw\s+new\s+\w*Error\(\s*[`'"][^`'"\n]*(?:rate_?limit|_5xx|http_\$\{|\b429\b|\b5\d\d\b)/i;
/**
 * The governor throws ConnectorRateLimitedError (`<name>_rate_limited`) when
 * 429s persist. Unless the connector catches it, only `retryablePattern`
 * makes that failure retryable.
 */
function governorErrorEscapes(code: string): boolean {
	return (
		/createConnectorHttpGovernor/.test(code) &&
		!/ConnectorRateLimitedError/.test(code)
	);
}
const RUN_CONNECTOR_CALL = /\brunConnector\s*\(/;

function needsBrowser(manifest: ReadinessManifest): boolean {
	return manifest.runtime_requirements?.bindings?.browser !== undefined;
}

export function checkSharedHelpers(
	source: string,
	manifest: ReadinessManifest,
): Step {
	const code = stripComments(source);
	const kind = needsBrowser(manifest) ? "browser" : "api";
	const findings = SHARED_HELPER_RULES.filter(
		(rule) =>
			(rule.appliesTo === "all" || rule.appliesTo === kind) &&
			rule.handRolled.test(code) &&
			!rule.usesShared.test(code),
	).map((rule) => `${rule.id}: ${rule.message}`);
	if (
		RUN_CONNECTOR_CALL.test(code) &&
		(RETRYABLE_ERROR_THROWN.test(code) || governorErrorEscapes(code)) &&
		!/\bretryablePattern\s*:/.test(code)
	) {
		findings.push(
			"retryable-pattern: throws rate-limit or HTTP-status errors (or uses the governor, which throws <name>_rate_limited), but runConnector sets no retryablePattern. The default (/ECONN|ETIMEDOUT|timeout/i) matches neither, so a rate limit or a 5xx fails the run as terminal. Set a pattern that matches the errors a later run can recover from.",
		);
	}
	if (findings.length === 0) {
		return {
			advisory: true,
			detail: "no hand-rolled version of a shared helper this step knows about",
			name: "shared helpers",
			verdict: "PASS",
		};
	}
	return {
		advisory: true,
		detail: `${findings.length} job(s) done by hand that the shared package already does`,
		name: "shared helpers",
		nextAction: findings.join("\n    "),
		verdict: "WEAK",
	};
}

// ─── semantics: optional manifest declarations left undecided ──────────────

/** Up to three date-time fields of a stream, as candidates for its time semantics. */
function timeFields(stream: ManifestStream): string {
	return Object.entries(stream.schema?.properties ?? {})
		.filter(([, prop]) => prop?.format === "date-time")
		.map(([field]) => field)
		.slice(0, 3)
		.join(", ");
}

function hasGroupByTime(stream: ManifestStream): boolean {
	const aggregations = stream.query?.aggregations as
		| { group_by_time?: unknown }
		| undefined;
	return (
		Array.isArray(aggregations?.group_by_time) &&
		aggregations.group_by_time.length > 0
	);
}

/** Stream names that already cover the account itself (who the owner is, their plan, their usage). */
const ACCOUNT_STREAM =
	/^(?:account_\w+|usage_summary|profile|user|user_stats)$/;

/**
 * Lists the optional declarations a connector has not made. Each is a
 * decision, not a demand: some do not apply to some streams. The contributor
 * makes each one or says in the PR why it does not apply.
 */
export function listOpenSemantics(manifest: ReadinessManifest): string[] {
	const open: string[] = [];
	const streams = streamsOf(manifest);
	let fields = 0;
	let described = 0;
	for (const stream of streams) {
		const name = streamName(stream);
		// A singleton (one record per account) has no history to bound or chart.
		const candidates =
			stream.coverage_strategy === "singleton_presence"
				? ""
				: timeFields(stream);
		if (candidates && stream.consent_time_field === undefined) {
			open.push(
				`${name}: consent_time_field — lets a grant limit this stream to a time range (date-time fields: ${candidates})`,
			);
		}
		if (candidates && !hasGroupByTime(stream)) {
			open.push(
				`${name}: query.aggregations.group_by_time — lets apps count and chart by time without reading every record (date-time fields: ${candidates})`,
			);
		}
		if (stream.incremental === true && stream.cursor_field === undefined) {
			open.push(
				`${name}: cursor_field — names the field the incremental cursor follows`,
			);
		}
		const props = Object.values(stream.schema?.properties ?? {}).filter(
			(p): p is SchemaProperty => typeof p === "object" && p !== null,
		);
		fields += props.length;
		described += props.filter(
			(p) => typeof p.description === "string" && p.description !== "",
		).length;
	}
	if (described < fields) {
		open.push(
			`field descriptions — ${described} of ${fields} schema fields say what they hold; apps and agents read these to understand the data`,
		);
	}
	if (
		streams.length > 1 &&
		!streams.some((s) => s.relationships !== undefined)
	) {
		open.push(
			"relationships — no stream links to another; declare the foreign key when one stream refers to another (for example highlights.book_id → books)",
		);
	}
	if (manifest.reason_display_messages === undefined) {
		open.push(
			"reason_display_messages — plain-words text the app shows for each failure reason",
		);
	}
	if (!streams.some((s) => ACCOUNT_STREAM.test(streamName(s)))) {
		open.push(
			"account streams — account_profile / account_plan / usage_summary where the platform has the data (see connectors/chatgpt/manifest.json)",
		);
	}
	return open;
}

export function checkSemantics(manifest: ReadinessManifest): Step {
	const open = listOpenSemantics(manifest);
	if (open.length === 0) {
		return {
			advisory: true,
			detail: "every optional declaration this step knows about is made",
			name: "semantics",
			verdict: "PASS",
		};
	}
	return {
		advisory: true,
		detail: `${open.length} optional declaration(s) not made. Make each one, or say in the PR why it does not apply. Rules for each: packages/polyfill-connectors/docs/connector-authoring-guide.md and docs/spec/collection-profile.md.`,
		name: "semantics",
		nextAction: open.join("\n    "),
		verdict: "ADVISORY",
	};
}

// ─── parse helpers used by conformance.ts ──────────────────────────────────

export interface CoverageRegistry {
	/** Connector keys in `CONNECTOR_DRIVERS`. */
	readonly drivers: ReadonlySet<string>;
	/** `<connector>.<stream>` entries in `KNOWN_UNEXERCISED_COVERAGE`. */
	readonly unexercised: ReadonlySet<string>;
}

/**
 * Reads `CONNECTOR_DRIVERS` keys and the `KNOWN_UNEXERCISED_COVERAGE` set
 * from the drivers file as text. Importing that module would load every
 * connector's driver. A missing block reads as empty, which makes the
 * coverage step a gap, never a pass.
 */
export function parseCoverageRegistry(driversSource: string): CoverageRegistry {
	const code = stripComments(driversSource);
	const block = (marker: string, open: string, close: string) => {
		const start = code.indexOf(marker);
		const from = start === -1 ? -1 : code.indexOf(open, start);
		const to = from === -1 ? -1 : code.indexOf(close, from);
		return to === -1 ? "" : code.slice(from, to);
	};
	const drivers = block("CONNECTOR_DRIVERS:", "{", "\n};");
	const unexercised = block("KNOWN_UNEXERCISED_COVERAGE", "new Set([", "]);");
	return {
		drivers: new Set(
			[...drivers.matchAll(/^\t["']?([a-z0-9_]+)["']?:/gm)].map(
				(m) => m[1] ?? "",
			),
		),
		unexercised: new Set(
			[...unexercised.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? ""),
		),
	};
}
