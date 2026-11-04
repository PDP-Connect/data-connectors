// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * AST-based scan for every reason code a connector's production source
 * actually emits on a `SKIP_RESULT`, `connector_error`, or `DETAIL_GAP`
 * event (the three event shapes that carry a `reason` value out to the
 * runtime/owner surface — `DETAIL_GAP` is built by the shared
 * `buildDetailGap`/`emitDetailGap` helpers in `src/connector-runtime.ts`, but
 * the `reason` value at each connector's call site is still that
 * connector's own fact). This replaces an earlier index.ts-only,
 * string-literal-only regex scan; two real blind spots motivated the
 * rewrite:
 *
 *   1. File scope. `usaa/statement-pdfs.ts` (a helper module, not
 *      index.ts) returned a closed set of internal failure reasons, and
 *      `usaa/index.ts` composed the emitted SKIP_RESULT.reason as a
 *      template literal (`` `pdf_download_${reason}` ``) — invisible to an
 *      index.ts-only scope. Nine real reason codes were live and
 *      uncovered until the connector was refactored to emit plain
 *      literals via an exhaustive map (see usaa/types.ts's
 *      DownloadFailReason + usaa/index.ts's PDF_DOWNLOAD_SKIP_REASON).
 *      This scanner now walks every non-test `.ts`/`.tsx` file directly
 *      under a connector's own directory.
 *
 *   2. Resolution depth. This codebase's real emission style is rarely a
 *      bare string literal at the SKIP_RESULT call site — it is usually a
 *      local variable (`reason: classification.reason`) or a call to a
 *      same-file classifier function (`reason:
 *      reasonForDetailFailure(failureKind)`) whose OWN body is a finite,
 *      literal-only switch/return chain. A zero-tolerance scan (require a
 *      bare literal at the call site) flagged dozens of these as
 *      "unresolved" even though they resolve to a genuinely finite,
 *      enumerable set one hop away — over-strict, not fail-closed in any
 *      useful sense. This scanner performs exactly ONE hop of resolution,
 *      matching the bound the RI zero-connector-knowledge guard's own
 *      data-load scanner already uses for parameter indirection:
 *        - Scope: only `reason:` properties inside an object literal
 *          whose sibling `type:` property is the string literal
 *          "SKIP_RESULT", "connector_error", or "DETAIL_GAP" are in scope
 *          at all. A `reason:` field on a schema definition, a diagnostic
 *          bag, an internal classifier's own return shape, or an unrelated
 *          helper type is out of scope entirely (scanned only insofar as
 *          it feeds an in-scope emission site's resolution).
 *        - An in-scope `reason:` value that is a plain string literal, or
 *          a ternary whose every branch is (recursively) a plain string
 *          literal, resolves directly.
 *        - An in-scope `reason:` value that is a plain Identifier
 *          resolves ONE hop: to that identifier's nearest enclosing
 *          same-function `const`/destructuring initializer, OR — if that
 *          initializer is itself a call to a function DEFINED IN THE SAME
 *          FILE — to the union of every string-literal `reason:` (or
 *          all-literal-ternary) value found in that function's own
 *          `return` statements (covers both a `reasonForDetailFailure`-
 *          style switch-of-literals function and a
 *          `classifyEmptyListPageDiagnostics`-style function returning
 *          `{ reason: <literal> }` object literals).
 *        - A `reason:` value that is a MemberExpression (`x.reason`)
 *          resolves the same one hop, through `x`'s local initializer; a
 *          computed MemberExpression (`MAP[identifier]`) resolves via the
 *          union of every literal value in `MAP`'s own module-level object
 *          literal (the usaa PDF_DOWNLOAD_SKIP_REASON pattern — the
 *          indexing identifier ranges over the map's own finite key domain
 *          by construction).
 *        - A `reason:` value that is a bare function parameter (e.g.
 *          `emitRequestedSkip(ctx, reason: string, message)` emitting
 *          `reason` directly) resolves via the union of every literal
 *          argument passed to that parameter position across the
 *          function's same-file call sites (the google_maps
 *          `emitRequestedSkip` pattern).
 *        - A `SpreadElement` inside an in-scope emission object literal
 *          that has NO OWN literal `reason:` property (`{ type:
 *          "SKIP_RESULT", stream, ...outcome.skip }`, the google_messages
 *          pattern, where the spread is the only possible source of
 *          `reason`) is fail-closed: reported as `unresolved`, one entry
 *          per spread, never silently skipped. A spread alongside an own
 *          literal `reason:` property (usaa's `{ type: "SKIP_RESULT",
 *          reason: "session_dead_reauth_failed", ...(diagnostic ? {
 *          diagnostics: {...} } : {}) }`, where the spread only ever
 *          contributes an unrelated field) is correctly NOT flagged — the
 *          own `reason:` property already resolves normally. Resolving
 *          through a flagged spread would need a further hop into the
 *          spread source's own shape on top of the existing one-hop bound;
 *          rather than grow the bound to chase one shape, an authoring
 *          change (destructure the reason at the call site into a literal
 *          `reason:` property, or spread into a variable the scanner can
 *          already resolve) is the fix, matching every other unresolved
 *          case's remedy.
 *        - Anything beyond that one hop — a second-order call, a cross-file
 *          import, a template literal, a binary `+`, or a parameter whose
 *          call-site argument is itself not a literal — is FAIL-CLOSED:
 *          reported as `unresolved`. The fix is an authoring change
 *          (refactor to an explicit literal-per-branch mapping, per the
 *          PDF_DOWNLOAD_SKIP_REASON pattern), never a deeper scanner —
 *          amazon's `buildOrderDetailGap`/chase's `buildAccountDetailGap`/
 *          usaa's `buildAccountTransactionDetailGap` all take `reason` as a
 *          parameter typed `DetailGapMessage["reason"]` (a closed
 *          four-value protocol union, all four already RI-generic) but
 *          pass a call-site variable traced back through an async
 *          classifier's return value — correctly unresolved here, and
 *          correctly a non-issue for completeness since the type itself
 *          proves every reachable value is RI-generic (see this file's
 *          sibling test for how DETAIL_GAP's closed reason union is
 *          special-cased at the completeness-check layer, not chased here).
 *
 * Thrown terminal codes (`terminalCodes`). A run can also end on a code the
 * connector throws instead of emitting, and the owner sees copy for that
 * code too. The scan counts two shapes, in the same file scope as above:
 *
 *   - `createConnectorFailure(code, ...)`: `code` becomes `DONE.error.code`
 *     wherever it is thrown. The first argument resolves with the same
 *     one-hop rules as a `reason:` value, plus a non-computed lookup into a
 *     module-level object of literals (`ERROR_CODE.AUTH_FAILED`). An argument
 *     that does not resolve is reported in `unresolvedTerminalCodes`
 *     (fail-closed), never skipped.
 *   - A bare `new Error(message)` / `Error(message)`, or `super(message)` in a
 *     class that directly `extends Error`, whose message is a literal (or an
 *     all-literal ternary, or an identifier that resolves one hop to
 *     literals) and is code-shaped per `isConnectorErrorCodeShaped`. Thrown or
 *     returned does not matter: a helper that returns the Error for its caller
 *     to throw (heb's `hebSessionRequired()`) is the same code. Other messages
 *     (spaces, colons, template literals with substitutions) are ignored.
 *
 * Which bare Errors really surface as a code: only one path in this package
 * turns a bare Error into `DONE.error.code`. `establishSession`
 * (session-establish.ts) catches whatever a connector's `ensureSession`
 * throws and, when the whole message is code-shaped, copies it to the
 * TerminalError's `code`. A bare Error thrown from `collect` reaches
 * `run().catch` in connector-runtime.ts and goes out with no code: only the
 * redacted message carries the token. The scan still counts every
 * code-shaped bare Error, for three reasons. Telling an `ensureSession` throw
 * from a `collect` throw needs a call graph, which this one-hop scanner does
 * not have, and one code can come from both (github_browser throws
 * `github_browser_session_missing` from `ensureSession` and again from
 * `collect`). A code that is message-only
 * today becomes a real code as soon as the connector moves the check into
 * `ensureSession` or wraps it in `createConnectorFailure`. And the gate must
 * fail closed: a code counted that never reaches `DONE.error.code` costs one
 * allowlist line, a code missed is copy the owner never gets. The known gap
 * in the other direction: a template-literal message
 * (`` `spotify_retryable_status_${status}` ``) can be code-shaped at run time
 * but is not a finite literal set, so it is not counted.
 *
 * Shared modules (`SHARED_TERMINAL_CODE_MODULES`). Some codes are thrown by
 * a shared helper, not by connector code: the Amazon sign-in flow
 * (auto-login/amazon.ts) and the browser sign-in helpers
 * (browser-handoff.ts). Each listed module's terminal codes are attributed to
 * every connector with a production file that imports it at run time
 * (a type-only import cannot throw), and to every connector that imports a
 * module named in its `reachedThrough` list (amazon.ts calls
 * `manualBrowserLogin`, so wholefoods reaches browser-handoff.ts's codes
 * through it). This is an explicit list, not an import-graph walk: a shared
 * module that is not listed (the other auto-login helpers, the runtime's own
 * session code) contributes nothing.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { parse } from "@babel/parser";
import type { DetailGapMessage } from "@pdpp/connector-protocol";
import { packageRoot } from "./connector-paths.ts";
import { isConnectorErrorCodeShaped } from "./terminal-error.ts";

interface ScanLocation {
	file: string;
	line: number;
	snippet: string;
}

export interface ReasonEmissionScanResult {
	/** Reason codes resolved (directly or via one hop) to a finite literal set. */
	literalReasons: string[];
	/** Terminal failure codes the connector can throw (see the module comment). */
	terminalCodes: string[];
	/** In-scope `reason:` values that could not be resolved within one hop. */
	unresolved: ScanLocation[];
	/** `createConnectorFailure` first arguments that could not be resolved within one hop. */
	unresolvedTerminalCodes: ScanLocation[];
}

/** A shared module whose thrown terminal codes belong to the connectors that import it. */
export interface SharedTerminalCodeModule {
	/** Absolute path of the shared module. */
	path: string;
	/** Absolute paths of other shared modules that call into this one; importing one of them also reaches this module's codes. */
	reachedThrough: readonly string[];
}

const AMAZON_LOGIN_MODULE = join(packageRoot, "src", "auto-login", "amazon.ts");
const BROWSER_HANDOFF_MODULE = join(packageRoot, "src", "browser-handoff.ts");

export const SHARED_TERMINAL_CODE_MODULES: readonly SharedTerminalCodeModule[] =
	[
		{ path: AMAZON_LOGIN_MODULE, reachedThrough: [] },
		{ path: BROWSER_HANDOFF_MODULE, reachedThrough: [AMAZON_LOGIN_MODULE] },
	];

const TEST_FILE_SUFFIXES = [".test.ts", ".test.tsx"];
const EMISSION_TYPES = new Set([
	"SKIP_RESULT",
	"connector_error",
	"DETAIL_GAP",
]);
const SNAKE_CASE_RE = /^[a-z][a-z0-9_]*$/;

/** Every non-test `.ts`/`.tsx` file directly under a connector's own directory (not recursive into subdirectories). */
export function connectorProductionFiles(connectorDir: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(connectorDir);
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const abs = join(connectorDir, entry);
		let isFile: boolean;
		try {
			isFile = statSync(abs).isFile();
		} catch {
			continue;
		}
		if (!isFile) {
			continue;
		}
		if (![".ts", ".tsx"].includes(extname(entry))) {
			continue;
		}
		if (TEST_FILE_SUFFIXES.some((suffix) => entry.endsWith(suffix))) {
			continue;
		}
		files.push(abs);
	}
	return files;
}

// --- Babel AST node shapes used below (loosely typed, matching the
// reference-implementation zero-connector-knowledge data-load scanner's own
// convention for the same dependency).

interface Node {
	type: string;
	[key: string]: unknown;
}

/** Single-step boundary conversion from a real (fully-typed) Babel AST node to this module's loosely-typed `Node` — every real Babel node already has a string `type` field, so this is a widening, not an unsafe double-cast; kept as one named function instead of an inline chained assertion so the boundary is explicit and auditable. */
function toNode(babelNode: { type: string }): Node {
	return babelNode as Node;
}

interface ObjectExpressionNode extends Node {
	properties: Node[];
	type: "ObjectExpression";
}

interface ObjectPropertyNode extends Node {
	computed: boolean;
	key: Node;
	type: "ObjectProperty";
	value: Node;
}

interface StringLiteralNode extends Node {
	type: "StringLiteral";
	value: string;
}

interface ConditionalExpressionNode extends Node {
	alternate: Node;
	consequent: Node;
	type: "ConditionalExpression";
}

interface IdentifierNode extends Node {
	name: string;
	type: "Identifier";
}

interface CallExpressionNode extends Node {
	callee: Node;
	type: "CallExpression";
}

function isObjectExpression(node: Node): node is ObjectExpressionNode {
	return node.type === "ObjectExpression";
}

function isStringLiteral(node: Node): node is StringLiteralNode {
	return node.type === "StringLiteral";
}

function isObjectProperty(node: Node): node is ObjectPropertyNode {
	return node.type === "ObjectProperty";
}

function isConditionalExpression(
	node: Node,
): node is ConditionalExpressionNode {
	return node.type === "ConditionalExpression";
}

function isIdentifier(node: Node): node is IdentifierNode {
	return node.type === "Identifier";
}

function isCallExpression(node: Node): node is CallExpressionNode {
	return node.type === "CallExpression";
}

function isSpreadElement(node: Node): boolean {
	return node.type === "SpreadElement";
}

/** Unwraps a function parameter node to its bound `Identifier` — either the parameter itself (`reason: T`) or, for a parameter with a default value (`reason: T = "x"`), the `AssignmentPattern`'s `left` (which is what carries the type annotation). `null` for a destructuring/other parameter shape. */
function paramIdentifier(param: Node): IdentifierNode | null {
	if (isIdentifier(param)) {
		return param;
	}
	if (param.type === "AssignmentPattern") {
		const { left } = param as { left?: Node };
		return left && isIdentifier(left) ? left : null;
	}
	return null;
}

function objectPropertyKeyName(prop: Node): string | undefined {
	if (!isObjectProperty(prop) || prop.computed) {
		return;
	}
	if (isIdentifier(prop.key)) {
		return prop.key.name;
	}
	return isStringLiteral(prop.key) ? prop.key.value : undefined;
}

/** True if this object literal has a sibling `type: "SKIP_RESULT"` / `"connector_error"` / `"DETAIL_GAP"` property. */
function isEmissionObjectLiteral(obj: ObjectExpressionNode): boolean {
	return obj.properties.some((prop) => {
		if (objectPropertyKeyName(prop) !== "type") {
			return false;
		}
		const value = isObjectProperty(prop) ? prop.value : undefined;
		return (
			value !== undefined &&
			isStringLiteral(value) &&
			EMISSION_TYPES.has(value.value)
		);
	});
}

/** Resolves a value expression that is directly a literal or all-literal ternary. Does NOT resolve identifiers/calls (that's the one-hop step in resolveReasonValue). */
function resolveDirectLiterals(node: Node): string[] | null {
	if (isStringLiteral(node)) {
		return SNAKE_CASE_RE.test(node.value) ? [node.value] : null;
	}
	if (isConditionalExpression(node)) {
		const consequent = resolveDirectLiterals(node.consequent);
		const alternate = resolveDirectLiterals(node.alternate);
		if (!(consequent && alternate)) {
			return null;
		}
		return [...consequent, ...alternate];
	}
	return null;
}

function nodeLine(node: Node): number {
	const loc = node.loc as { start?: { line?: number } } | undefined;
	return loc?.start?.line ?? 0;
}

function walk(node: unknown, visit: (n: Node) => void): void {
	if (!node || typeof node !== "object") {
		return;
	}
	if (Array.isArray(node)) {
		for (const item of node) {
			walk(item, visit);
		}
		return;
	}
	const n = node as Node;
	if (typeof n.type === "string") {
		visit(n);
	}
	for (const key of Object.keys(n)) {
		if (key === "loc" || key === "start" || key === "end" || key === "range") {
			continue;
		}
		const child = (n as Record<string, unknown>)[key];
		if (child && typeof child === "object") {
			walk(child, visit);
		}
	}
}

/**
 * Resolves one return-statement argument's contribution to the `reason:`
 * literal set: a direct literal/ternary-of-literals, an object literal's
 * `reason:` property (direct literal/ternary — a return whose object has NO
 * `reason:` property at all is a legitimate non-skip/success branch,
 * contributing nothing), a ternary whose branches are each one of those
 * shapes, or a delegating `return someSameFileFunction(...)` (transitively
 * resolved via that function's own return set — `visiting` guards against a
 * cycle between mutually-delegating functions, which would otherwise
 * recurse forever on pathological same-file code). `null` means genuinely
 * unresolvable within this bound.
 */
function reasonContributionFromReturnArgument(
	argument: Node,
	program: Node,
	visiting: Set<string>,
): string[] | null {
	const direct = resolveDirectLiterals(argument);
	if (direct) {
		return direct;
	}
	if (isObjectExpression(argument)) {
		return reasonPropertyLiteralsFromObjectExpression(argument);
	}
	if (isConditionalExpression(argument)) {
		const consequent = reasonContributionFromReturnArgument(
			argument.consequent,
			program,
			visiting,
		);
		const alternate = reasonContributionFromReturnArgument(
			argument.alternate,
			program,
			visiting,
		);
		if (!(consequent && alternate)) {
			return null;
		}
		return [...consequent, ...alternate];
	}
	// `return someSameFileFunction(...)` — transitively resolve via that
	// function's own return set, same-file only, cycle-guarded.
	return resolveDelegatingReturnCall(argument, program, visiting);
}

/** Collects the direct-literal `reason:` property values from an object literal's own properties (does not recurse into ternaries or nested calls — that's the caller's job). Returns `null` if any in-scope `reason:` property has an unresolvable value. */
function reasonPropertyLiteralsFromObjectExpression(
	argument: ObjectExpressionNode,
): string[] | null {
	const results: string[] = [];
	for (const prop of argument.properties) {
		if (objectPropertyKeyName(prop) !== "reason" || !isObjectProperty(prop)) {
			continue;
		}
		const resolved = resolveDirectLiterals(prop.value);
		if (!resolved) {
			return null;
		}
		results.push(...resolved);
	}
	return results;
}

/** Resolves `return someSameFileFunction(...)` (optionally `await`ed) transitively via that function's own return set. `null` if the argument isn't a same-file delegating call, the function can't be found, or `visiting` already covers it (cycle guard). */
function resolveDelegatingReturnCall(
	argument: Node,
	program: Node,
	visiting: Set<string>,
): string[] | null {
	const unwrapped = unwrapAwait(argument);
	if (!(isCallExpression(unwrapped) && isIdentifier(unwrapped.callee))) {
		// Neither a literal/ternary, an object literal, a ternary of those, nor
		// a same-file delegating call — genuinely unresolvable within this bound.
		return null;
	}
	if (visiting.has(unwrapped.callee.name)) {
		return null;
	}
	const fn = findFunctionDefinition(program, unwrapped.callee.name);
	return fn ? literalReasonsFromFunctionReturns(fn, program, visiting) : null;
}

/** If `node` is a named `FunctionDeclaration` (`function name() {...}`), returns its name; `undefined` for an anonymous/arrow/expression function or any other node type. */
function functionDeclarationName(node: Node): string | undefined {
	if (node.type !== "FunctionDeclaration") {
		return;
	}
	const { id } = node as { id?: Node };
	return id && isIdentifier(id) ? id.name : undefined;
}

/** Collects every string-literal `reason:` value from a function body's `return` statements — covers a switch-of-literals function, a function returning `{ reason: <literal> }` object literals, ternaries of either shape, and same-file delegating returns. */
function literalReasonsFromFunctionReturns(
	functionNode: Node,
	program: Node,
	visiting: Set<string> = new Set(),
): string[] | null {
	const fnName = functionDeclarationName(functionNode);
	const nextVisiting = fnName ? new Set(visiting).add(fnName) : visiting;

	const results: string[] = [];
	let sawAnyReturn = false;
	let allResolved = true;

	walk(functionNode.body, (node) => {
		if (node.type !== "ReturnStatement") {
			return;
		}
		sawAnyReturn = true;
		const { argument } = node as { argument?: Node };
		if (!argument) {
			return;
		}
		const contribution = reasonContributionFromReturnArgument(
			argument,
			program,
			nextVisiting,
		);
		if (contribution) {
			results.push(...contribution);
		} else {
			allResolved = false;
		}
	});

	if (!(sawAnyReturn && allResolved)) {
		return null;
	}
	return results;
}

/** Finds a same-file function declaration/expression bound to `name` (function declaration, or const/let arrow-function/function-expression). */
function findFunctionDefinition(program: Node, name: string): Node | null {
	let found: Node | null = null;
	walk(program, (node) => {
		if (found) {
			return;
		}
		if (functionDeclarationName(node) === name) {
			found = node;
			return;
		}
		if (node.type === "VariableDeclarator") {
			const { id, init } = node as { id?: Node; init?: Node };
			if (
				id &&
				isIdentifier(id) &&
				id.name === name &&
				init &&
				(init.type === "ArrowFunctionExpression" ||
					init.type === "FunctionExpression")
			) {
				found = init;
			}
		}
	});
	return found;
}

/** Finds every `const`/`let` (or destructuring) initializer/assignment for `name` within `scope` (a function body or the whole program for module scope). Includes `let x = ...; ...; x = ...` reassignments so an if/else-branch-assigned variable resolves to the union of every branch. */
function findLocalInitializers(scope: Node, name: string): Node[] {
	const found: Node[] = [];
	walk(scope, (node) => {
		if (node.type === "VariableDeclarator") {
			collectVariableDeclaratorInitializers(node, name, found);
			return;
		}
		// `x = "literal"` reassignment (e.g. inside an if/else after `let x;`).
		if (node.type === "AssignmentExpression") {
			const { left, right } = node as { left?: Node; right?: Node };
			if (left && isIdentifier(left) && left.name === name && right) {
				found.push(right);
			}
		}
	});
	return found;
}

/** Appends `name`'s initializer to `found` for one `VariableDeclarator` node — either a direct `const name = init` binding, or a `const { reason } = init` / `const { reason: name } = init` destructuring binding whose `reason:` property is bound to `name`. */
function collectVariableDeclaratorInitializers(
	node: Node,
	name: string,
	found: Node[],
): void {
	const { id, init } = node as { id?: Node; init?: Node };
	if (!(id && init)) {
		return;
	}
	if (isIdentifier(id) && id.name === name) {
		found.push(init);
		return;
	}
	if (id.type === "ObjectPattern") {
		collectDestructuredReasonInitializer(id, init, name, found);
	}
}

/** Appends `init` to `found` once per `reason:` property in an `ObjectPattern` whose bound local name matches `name` — covers both `const { reason } = init` and `const { reason: alias } = init`. */
function collectDestructuredReasonInitializer(
	id: Node,
	init: Node,
	name: string,
	found: Node[],
): void {
	const { properties: props = [] } = id as { properties?: Node[] };
	for (const prop of props) {
		if (prop.type !== "ObjectProperty") {
			continue;
		}
		const { value } = prop as { value?: Node };
		const boundName = value && isIdentifier(value) ? value.name : undefined;
		if (boundName === name && objectPropertyKeyName(prop) === "reason") {
			found.push(init);
		}
	}
}

/** Strips `await` wrapping (`await expr` -> `expr`); returns the node unchanged if it isn't an AwaitExpression. */
function unwrapAwait(node: Node): Node {
	return node.type === "AwaitExpression" &&
		(node as { argument?: Node }).argument
		? ((node as { argument?: Node }).argument as Node)
		: node;
}

/** Resolves a same-file function-call expression to that function's literal return set. `undefined` (not `null`) signals "not even shaped like a resolvable call" so callers can distinguish from a call that resolved to nothing. */
function resolveCallExpressionLiterals(
	node: Node,
	program: Node,
): string[] | null | undefined {
	const unwrapped = unwrapAwait(node);
	if (!(isCallExpression(unwrapped) && isIdentifier(unwrapped.callee))) {
		return;
	}
	const fn = findFunctionDefinition(program, unwrapped.callee.name);
	return fn ? literalReasonsFromFunctionReturns(fn, program) : null;
}

/** Resolves `x.reason` where `x`'s initializer is an (optionally awaited) same-file function call, or a ternary whose branches are each such a call — via that function's own literal `reason:` return-object properties. `null` for any other initializer shape (a bare literal/object initializer has no meaningful `.reason` member for this pattern). */
function resolveMemberReasonFromCallInitializer(
	node: Node,
	program: Node,
): string[] | null {
	const fromCall = resolveCallExpressionLiterals(node, program);
	if (fromCall !== undefined) {
		return fromCall;
	}
	if (isConditionalExpression(node)) {
		const consequent = resolveMemberReasonFromCallInitializer(
			node.consequent,
			program,
		);
		const alternate = resolveMemberReasonFromCallInitializer(
			node.alternate,
			program,
		);
		if (!(consequent && alternate)) {
			return null;
		}
		return [...consequent, ...alternate];
	}
	return null;
}

/** One hop through an identifier: resolves via its local initializer(s)/reassignment(s) — a direct literal, an (optionally awaited) same-file function call, or a ternary whose branches are each one of those. `null` if any contributing value is unresolvable. */
function resolveIdentifierOneHop(
	name: string,
	program: Node,
	scope: Node,
): string[] | null {
	const initializers = findLocalInitializers(scope, name);
	if (initializers.length === 0) {
		return null;
	}
	const results: string[] = [];
	for (const initializer of initializers) {
		const resolved = resolveInitializerExpression(initializer, program);
		if (!resolved) {
			return null;
		}
		results.push(...resolved);
	}
	return results;
}

/** Resolves one initializer/assigned expression: direct literal/ternary, an (optionally awaited) same-file function call, or a ternary of those. */
function resolveInitializerExpression(
	node: Node,
	program: Node,
): string[] | null {
	const direct = resolveDirectLiterals(node);
	if (direct) {
		return direct;
	}
	const fromCall = resolveCallExpressionLiterals(node, program);
	if (fromCall !== undefined) {
		return fromCall;
	}
	if (isConditionalExpression(node)) {
		const consequent = resolveInitializerExpression(node.consequent, program);
		const alternate = resolveInitializerExpression(node.alternate, program);
		if (!(consequent && alternate)) {
			return null;
		}
		return [...consequent, ...alternate];
	}
	return null;
}

/**
 * For a function that returns `reason` as a parameter passthrough (e.g.
 * `emitRequestedSkip(ctx, reason: string, message: string)` emitting
 * `reason` directly, or a `buildXDetailGap({ reason, ... })`-style function
 * whose `reason` is destructured straight into the emitted object), resolves
 * the union of every literal argument passed to that parameter position
 * across the function's same-file call sites. One hop only: an argument that
 * is itself not a direct literal (or all-literal ternary) at the call site
 * is unresolved — e.g. `buildAccountDetailGap(outcome)` where `outcome.reason`
 * traces back through an async classifier's return type rather than a
 * literal argument stays (correctly) unresolved, forcing an authoring fix
 * rather than a deeper scanner.
 */
function resolveParameterFromCallSites(
	program: Node,
	functionNode: Node,
	paramIndex: number,
): string[] | null {
	const fnName = functionDeclarationName(functionNode);
	if (!fnName) {
		return null;
	}
	const results: string[] = [];
	let sawAnyCall = false;
	walk(program, (node) => {
		if (
			!(isCallExpression(node) && isIdentifier(node.callee)) ||
			node.callee.name !== fnName
		) {
			return;
		}
		sawAnyCall = true;
		const args = (node as { arguments?: Node[] }).arguments ?? [];
		const arg = args[paramIndex];
		const resolved = arg ? resolveDirectLiterals(arg) : null;
		if (resolved) {
			results.push(...resolved);
		} else {
			results.push("__UNRESOLVED__");
		}
	});
	if (!sawAnyCall || results.includes("__UNRESOLVED__")) {
		return null;
	}
	return results;
}

/** If `name` is a parameter of `enclosingFunction`, resolves via that function's same-file call-site arguments (see resolveParameterFromCallSites). */
function resolveParameterIdentifier(
	name: string,
	program: Node,
	enclosingFunction: Node,
): string[] | null {
	const params = (enclosingFunction as { params?: Node[] }).params ?? [];
	const paramIndex = params.findIndex((p) => paramIdentifier(p)?.name === name);
	if (paramIndex === -1) {
		return null;
	}
	return resolveParameterFromCallSites(program, enclosingFunction, paramIndex);
}

/**
 * `MAP[identifier]` — computed access into a module-level object literal
 * with all-literal values (e.g. an exhaustive `Record<SomeUnion, string>`
 * map, the usaa PDF_DOWNLOAD_SKIP_REASON pattern). Resolves to the union of
 * every value in the map: the indexing identifier ranges over the map's own
 * finite key domain by construction (enforced at the TypeScript level), so
 * every value is a reachable result.
 */
function resolveComputedMapAccess(
	mapName: string,
	program: Node,
): string[] | null {
	const mapInitializers = findLocalInitializers(program, mapName);
	const mapLiteral = mapInitializers.find((init) => isObjectExpression(init));
	if (!(mapLiteral && isObjectExpression(mapLiteral))) {
		return null;
	}
	const values: string[] = [];
	for (const prop of mapLiteral.properties) {
		if (!isObjectProperty(prop)) {
			return null;
		}
		const resolved = resolveDirectLiterals(prop.value);
		if (!resolved) {
			return null;
		}
		values.push(...resolved);
	}
	return values;
}

/**
 * Resolves a TS type annotation node to a finite literal set ONLY when it is
 * a string-literal union written directly (`"a" | "b" | "c"`) or a single
 * hop through a local `type X = "a" | "b"` alias declared in the same file
 * (e.g. amazon's `AmazonDetailGapReason`). This is sound independent of this
 * scanner's value-level dataflow reach: TypeScript itself guarantees no
 * value of this type can be anything outside the literal set, however deep
 * the runtime expression producing it is (an async classifier's return
 * type, a narrowed union member, etc.) — the protocol-level
 * `DetailGapMessage["reason"]` union (`DETAIL_GAP_MESSAGE_REASON_LITERALS`
 * below, compile-time-checked exhaustive against the real type) is the
 * motivating case: every one of its four members is already RI-generic, so
 * a `reason: DetailGapMessage["reason"]`-typed parameter can never carry a
 * connector-specific code, no matter how many hops its runtime value takes
 * to compute. Returns `null` for any other annotation shape (a bare `string`,
 * an imported/cross-file type, a non-literal union member) — those stay
 * fail-closed, same as an unresolvable value.
 */
function resolveTypeAnnotationLiterals(
	typeAnnotationNode: Node | undefined,
	program: Node,
): string[] | null {
	if (!typeAnnotationNode) {
		return null;
	}
	const inner =
		(typeAnnotationNode as { typeAnnotation?: Node }).typeAnnotation ??
		typeAnnotationNode;
	if (inner.type === "TSUnionType") {
		return resolveTsUnionTypeLiterals(inner);
	}
	if (inner.type === "TSTypeReference") {
		const { typeName } = inner as { typeName?: Node };
		if (typeName && isIdentifier(typeName)) {
			return resolveLocalTypeAliasLiterals(typeName.name, program);
		}
	}
	if (inner.type === "TSIndexedAccessType") {
		return resolveDetailGapMessageReasonIndexedAccess(inner);
	}
	return null;
}

/**
 * `DetailGapMessage["reason"]` (imported cross-file, by TYPE only, from
 * `src/connector-runtime-protocol.ts`) is a fixed, closed protocol union.
 * `resolveDetailGapMessageReasonIndexedAccess` below still matches the
 * `DetailGapMessage["reason"]` type-annotation SHAPE by name/string-literal
 * comparison at the AST level (this scanner's normal same-file resolution
 * bound genuinely cannot follow a cross-file type import at runtime) — but
 * the VALUE SET it resolves to is no longer a hand-maintained array that
 * could silently drift from the real union. `DETAIL_GAP_MESSAGE_REASON_KEYS`
 * is `satisfies Record<DetailGapMessage["reason"], true>`: TypeScript
 * itself rejects this file at compile time if a key is missing (the real
 * union widens) or extra (the real union narrows) — drift is a `tsc`
 * failure, not a silent gap. `Object.keys(...)` then derives the runtime
 * array from that single compile-time-checked object, so there is exactly
 * one source of truth for "what are DetailGapMessage's reason values,"
 * never two lists that could disagree.
 */
const DETAIL_GAP_MESSAGE_REASON_KEYS = {
	rate_limited: true,
	retry_exhausted: true,
	temporary_unavailable: true,
	upstream_pressure: true,
} satisfies Record<DetailGapMessage["reason"], true>;

export const DETAIL_GAP_MESSAGE_REASON_LITERALS: readonly string[] =
	Object.keys(DETAIL_GAP_MESSAGE_REASON_KEYS);

function resolveDetailGapMessageReasonIndexedAccess(
	node: Node,
): string[] | null {
	const { objectType, indexType } = node as {
		objectType?: Node;
		indexType?: Node;
	};
	const objectTypeName =
		objectType?.type === "TSTypeReference" &&
		isIdentifier((objectType as { typeName?: Node }).typeName as Node)
			? ((objectType as { typeName?: Node }).typeName as IdentifierNode).name
			: undefined;
	const indexLiteral =
		indexType?.type === "TSLiteralType"
			? (indexType as { literal?: Node }).literal
			: undefined;
	const indexValue =
		indexLiteral && isStringLiteral(indexLiteral)
			? indexLiteral.value
			: undefined;
	if (objectTypeName === "DetailGapMessage" && indexValue === "reason") {
		return [...DETAIL_GAP_MESSAGE_REASON_LITERALS];
	}
	return null;
}

/** Resolves a `TSUnionType` node to its literal members; `null` if any member isn't a plain string-literal type. */
function resolveTsUnionTypeLiterals(unionNode: Node): string[] | null {
	const { types = [] } = unionNode as { types?: Node[] };
	const results: string[] = [];
	for (const member of types) {
		if (member.type !== "TSLiteralType") {
			return null;
		}
		const { literal } = member as { literal?: Node };
		if (
			!(
				literal &&
				isStringLiteral(literal) &&
				SNAKE_CASE_RE.test(literal.value)
			)
		) {
			return null;
		}
		results.push(literal.value);
	}
	return results.length > 0 ? results : null;
}

/** Resolves a same-file `type Name = "a" | "b"` alias declaration to its literal union members. `null` if no such same-file alias exists or its right-hand side isn't a plain literal union. */
function resolveLocalTypeAliasLiterals(
	name: string,
	program: Node,
): string[] | null {
	let found: Node | null = null;
	walk(program, (node) => {
		if (found || node.type !== "TSTypeAliasDeclaration") {
			return;
		}
		const { id, typeAnnotation } = node as { id?: Node; typeAnnotation?: Node };
		if (id && isIdentifier(id) && id.name === name && typeAnnotation) {
			found = typeAnnotation;
		}
	});
	return found ? resolveTsUnionTypeLiterals(found) : null;
}

/** Resolves a plain `reason: identifier` value: prefers the nearest enclosing function scope (local initializer, then parameter/call-site union, then the parameter's own type annotation), falling back to module (program) scope for a top-level `const NAME = "literal"`. */
function resolveReasonIdentifier(
	name: string,
	program: Node,
	enclosingFunction: Node | null,
): string[] | null {
	if (enclosingFunction) {
		const inFunction = resolveIdentifierOneHop(
			name,
			program,
			enclosingFunction,
		);
		if (inFunction) {
			return inFunction;
		}
		const paramResolved = resolveParameterIdentifier(
			name,
			program,
			enclosingFunction,
		);
		if (paramResolved) {
			return paramResolved;
		}
		const params = (enclosingFunction as { params?: Node[] }).params ?? [];
		const param = params.find((p) => paramIdentifier(p)?.name === name);
		const paramId = param ? paramIdentifier(param) : null;
		const typeResolved = paramId
			? resolveTypeAnnotationLiterals(paramId.typeAnnotation as Node, program)
			: null;
		if (typeResolved) {
			return typeResolved;
		}
	}
	return resolveIdentifierOneHop(name, program, program);
}

/**
 * Resolves an in-scope `reason:` value, performing at most one hop through
 * an identifier/member-expression to its local initializer, a same-file
 * function's literal-only return set, a computed map lookup, or (for a
 * parameter identifier) the union of that function's same-file call-site
 * literal arguments. Returns `null` if unresolved within that bound.
 */
function resolveReasonValue(
	valueNode: Node,
	program: Node,
	enclosingFunction: Node | null,
): string[] | null {
	const direct = resolveDirectLiterals(valueNode);
	if (direct) {
		return direct;
	}

	if (isIdentifier(valueNode)) {
		return resolveReasonIdentifier(valueNode.name, program, enclosingFunction);
	}

	if (valueNode.type === "MemberExpression") {
		return resolveReasonMemberExpression(valueNode, program, enclosingFunction);
	}

	if (isCallExpression(valueNode) && isIdentifier(valueNode.callee)) {
		const fn = findFunctionDefinition(program, valueNode.callee.name);
		return fn ? literalReasonsFromFunctionReturns(fn, program) : null;
	}

	return null;
}

/** Resolves a `reason:` value that is a MemberExpression — either `MAP[identifier]` (computed) or `x.reason` (non-computed). `null` for any other member-expression shape. */
function resolveReasonMemberExpression(
	valueNode: Node,
	program: Node,
	enclosingFunction: Node | null,
): string[] | null {
	const { object, property, computed } = valueNode as {
		object?: Node;
		property?: Node;
		computed?: boolean;
	};

	if (computed && object && isIdentifier(object)) {
		return resolveComputedMapAccess(object.name, program);
	}

	const propertyName =
		property && isIdentifier(property) ? property.name : undefined;
	if (
		!computed &&
		object &&
		isIdentifier(object) &&
		propertyName === "reason" &&
		enclosingFunction
	) {
		const initializers = findLocalInitializers(enclosingFunction, object.name);
		if (initializers.length > 0) {
			const results: string[] = [];
			for (const initializer of initializers) {
				const fromCall = resolveMemberReasonFromCallInitializer(
					initializer,
					program,
				);
				if (!fromCall) {
					return null;
				}
				results.push(...fromCall);
			}
			return results;
		}
		// `object` has no local initializer — check whether it is itself a
		// function parameter with an inline object-type annotation carrying a
		// `reason:` property type (the chase buildAccountDetailGap / usaa
		// buildAccountTransactionDetailGap `outcome.reason` pattern, where
		// `outcome: { reason: DetailGapMessage["reason"]; ... }`).
		return resolveParameterPropertyTypeLiterals(
			object.name,
			propertyName,
			enclosingFunction,
			program,
		);
	}
	return null;
}

/** If `paramName` is a parameter of `enclosingFunction` with an inline `{ ... }` object-type annotation, resolves `propertyName`'s own type annotation within that object type via `resolveTypeAnnotationLiterals`. `null` if the parameter isn't found, isn't an inline object type, or has no matching property. */
function resolveParameterPropertyTypeLiterals(
	paramName: string,
	propertyName: string,
	enclosingFunction: Node,
	program: Node,
): string[] | null {
	const params = (enclosingFunction as { params?: Node[] }).params ?? [];
	const param = params.find((p) => paramIdentifier(p)?.name === paramName);
	const paramId = param ? paramIdentifier(param) : null;
	if (!paramId) {
		return null;
	}
	const annotation = paramId.typeAnnotation as Node | undefined;
	const inner = (annotation as { typeAnnotation?: Node } | undefined)
		?.typeAnnotation;
	if (inner?.type !== "TSTypeLiteral") {
		return null;
	}
	const { members = [] } = inner as { members?: Node[] };
	for (const member of members) {
		if (member.type !== "TSPropertySignature") {
			continue;
		}
		const { key } = member as { key?: Node };
		if (key && isIdentifier(key) && key.name === propertyName) {
			return resolveTypeAnnotationLiterals(
				(member as { typeAnnotation?: Node }).typeAnnotation,
				program,
			);
		}
	}
	return null;
}

const FUNCTION_NODE_TYPES = new Set([
	"FunctionDeclaration",
	"FunctionExpression",
	"ArrowFunctionExpression",
]);

/** Scans one file's source for every reason code emitted on a SKIP_RESULT/connector_error/DETAIL_GAP object literal, and every terminal code it throws. */
export function scanFileForReasonEmissions(
	absPath: string,
): ReasonEmissionScanResult {
	return scanSourceFile(absPath).result;
}

/** One file's scan result plus the absolute paths of the relative modules it imports at run time. */
function scanSourceFile(absPath: string): {
	importedPaths: string[];
	result: ReasonEmissionScanResult;
} {
	const raw = readFileSync(absPath, "utf8");
	const ctx: ScanContext = {
		absPath,
		literalReasons: [],
		program: { type: "Program" },
		raw,
		terminalCodes: [],
		unresolved: [],
		unresolvedTerminalCodes: [],
	};

	let ast: Node;
	try {
		const isJsxExtension = absPath.endsWith(".tsx");
		ast = toNode(
			parse(raw, {
				errorRecovery: true,
				plugins: isJsxExtension ? ["typescript", "jsx"] : ["typescript"],
				sourceType: "module",
			}),
		);
	} catch {
		// A file that fails to parse contributes nothing; this mirrors the
		// fail-soft-on-parse-error posture of the RI zero-connector-knowledge
		// data-load scanner (a parse failure here is a build error elsewhere,
		// not something this scan should crash on).
		return { importedPaths: [], result: scanResultOf(ctx) };
	}

	ctx.program = (ast as { program?: Node }).program ?? ast;
	walkWithFunctionScope(ctx.program, null, ctx);

	return {
		importedPaths: runtimeImportedPaths(ctx.program, absPath),
		result: scanResultOf(ctx),
	};
}

function scanResultOf(ctx: ScanContext): ReasonEmissionScanResult {
	return {
		literalReasons: [...new Set(ctx.literalReasons)],
		terminalCodes: [...new Set(ctx.terminalCodes)],
		unresolved: ctx.unresolved,
		unresolvedTerminalCodes: ctx.unresolvedTerminalCodes,
	};
}

/** Mutable accumulators + fixed inputs threaded through the AST walk for one file scan, so the walk/record helpers below don't need to be closures nested inside `scanFileForReasonEmissions` (nesting depth is itself a cognitive-complexity cost). */
interface ScanContext {
	absPath: string;
	literalReasons: string[];
	program: Node;
	raw: string;
	terminalCodes: string[];
	unresolved: ScanLocation[];
	unresolvedTerminalCodes: ScanLocation[];
}

function scanLocation(node: Node, ctx: ScanContext): ScanLocation {
	return {
		file: ctx.absPath,
		line: nodeLine(node),
		snippet: ctx.raw.split("\n")[nodeLine(node) - 1]?.trim() ?? "",
	};
}

// --- Thrown terminal codes (see the module comment) ---

/** Strips TypeScript-only wrappers (`x as const`, `x satisfies T`, `x!`) that do not change the runtime value. */
function unwrapTsExpression(node: Node): Node {
	let current = node;
	while (
		current.type === "TSAsExpression" ||
		current.type === "TSSatisfiesExpression" ||
		current.type === "TSNonNullExpression"
	) {
		const { expression } = current as { expression?: Node };
		if (!expression) {
			break;
		}
		current = expression;
	}
	return current;
}

/** The value of a template literal with no substitutions (`` `a_b` ``); `undefined` for anything else. */
function plainTemplateLiteralValue(node: Node): string | undefined {
	if (node.type !== "TemplateLiteral") {
		return;
	}
	const { expressions = [], quasis = [] } = node as {
		expressions?: Node[];
		quasis?: { value?: { cooked?: string } }[];
	};
	if (expressions.length > 0 || quasis.length !== 1) {
		return;
	}
	return quasis[0]?.value?.cooked;
}

/** `OBJ.KEY` where `OBJ` is a module-level object literal (optionally `as const`) whose `KEY` property is a literal (the apple_contacts `APPLE_CONTACTS_ERROR_CODE.AUTH_FAILED` pattern). `null` for any other shape. */
function resolveConstObjectMember(node: Node, program: Node): string[] | null {
	if (node.type !== "MemberExpression") {
		return null;
	}
	const { object, property, computed } = node as {
		object?: Node;
		property?: Node;
		computed?: boolean;
	};
	if (computed || !(object && isIdentifier(object))) {
		return null;
	}
	if (!(property && isIdentifier(property))) {
		return null;
	}
	for (const init of findLocalInitializers(program, object.name)) {
		const literal = unwrapTsExpression(init);
		if (!isObjectExpression(literal)) {
			continue;
		}
		const prop = literal.properties.find(
			(p) => objectPropertyKeyName(p) === property.name,
		);
		if (prop && isObjectProperty(prop)) {
			return resolveDirectLiterals(prop.value);
		}
	}
	return null;
}

/** Resolves `createConnectorFailure`'s first argument with the `reason:` one-hop rules, plus a const-object member lookup. `null` if unresolved. */
function resolveFailureCodeArgument(
	arg: Node,
	program: Node,
	enclosingFunction: Node | null,
): string[] | null {
	const node = unwrapTsExpression(arg);
	const template = plainTemplateLiteralValue(node);
	if (template !== undefined) {
		return SNAKE_CASE_RE.test(template) ? [template] : null;
	}
	return (
		resolveConstObjectMember(node, program) ??
		resolveReasonValue(node, program, enclosingFunction)
	);
}

/** The code-shaped literal values an Error message argument can take: a literal, the code-shaped leaves of a ternary, or an identifier that resolves one hop to literals. Anything else (template literal with substitutions, a call, a concatenation) yields nothing. */
function codeShapedErrorMessages(
	arg: Node,
	program: Node,
	enclosingFunction: Node | null,
): string[] {
	const node = unwrapTsExpression(arg);
	const template = plainTemplateLiteralValue(node);
	if (template !== undefined) {
		return isConnectorErrorCodeShaped(template) ? [template] : [];
	}
	if (isStringLiteral(node)) {
		return isConnectorErrorCodeShaped(node.value) ? [node.value] : [];
	}
	if (isConditionalExpression(node)) {
		return [
			...codeShapedErrorMessages(node.consequent, program, enclosingFunction),
			...codeShapedErrorMessages(node.alternate, program, enclosingFunction),
		];
	}
	if (isIdentifier(node)) {
		const resolved = resolveReasonIdentifier(
			node.name,
			program,
			enclosingFunction,
		);
		return (resolved ?? []).filter(isConnectorErrorCodeShaped);
	}
	return [];
}

/** True if `callee` names `name` directly (`name(...)`) or as a member (`x.name(...)`). */
function calleeNamed(callee: Node, name: string): boolean {
	if (isIdentifier(callee)) {
		return callee.name === name;
	}
	if (callee.type === "MemberExpression") {
		const { property, computed } = callee as {
			property?: Node;
			computed?: boolean;
		};
		return !computed && property !== undefined && isIdentifier(property)
			? property.name === name
			: false;
	}
	return false;
}

function firstArgument(node: Node): Node | undefined {
	const args = (node as { arguments?: Node[] }).arguments ?? [];
	const first = args[0];
	return first && first.type !== "SpreadElement" ? first : undefined;
}

/** True for a class declaration/expression that directly `extends Error`. */
function isErrorSubclass(node: Node): boolean {
	if (node.type !== "ClassDeclaration" && node.type !== "ClassExpression") {
		return false;
	}
	const { superClass } = node as { superClass?: Node | null };
	return Boolean(
		superClass && isIdentifier(superClass) && superClass.name === "Error",
	);
}

/** Records the code-shaped `super(message)` literals of a class that directly extends Error (the browser-handoff `BrowserSignInCancelledError` pattern). */
function recordErrorSubclassCodes(
	classNode: Node,
	enclosingFunction: Node | null,
	ctx: ScanContext,
): void {
	walk((classNode as { body?: Node }).body, (node) => {
		if (!isCallExpression(node) || node.callee.type !== "Super") {
			return;
		}
		const arg = firstArgument(node);
		if (arg) {
			ctx.terminalCodes.push(
				...codeShapedErrorMessages(arg, ctx.program, enclosingFunction),
			);
		}
	});
}

/** Records the terminal code(s) of one `createConnectorFailure(...)` call or bare `Error(...)` construction; any other node is ignored. */
function recordTerminalCodeSite(
	node: Node,
	enclosingFunction: Node | null,
	ctx: ScanContext,
): void {
	if (isErrorSubclass(node)) {
		recordErrorSubclassCodes(node, enclosingFunction, ctx);
		return;
	}
	if (node.type !== "CallExpression" && node.type !== "NewExpression") {
		return;
	}
	const { callee } = node as { callee?: Node };
	const arg = firstArgument(node);
	if (!callee) {
		return;
	}
	if (
		node.type === "CallExpression" &&
		calleeNamed(callee, "createConnectorFailure")
	) {
		const resolved = arg
			? resolveFailureCodeArgument(arg, ctx.program, enclosingFunction)
			: null;
		if (resolved) {
			ctx.terminalCodes.push(...resolved);
		} else {
			ctx.unresolvedTerminalCodes.push(scanLocation(arg ?? node, ctx));
		}
		return;
	}
	if (isIdentifier(callee) && callee.name === "Error" && arg) {
		ctx.terminalCodes.push(
			...codeShapedErrorMessages(arg, ctx.program, enclosingFunction),
		);
	}
}

/** Strips a JS/TS source extension so `./x.ts`, `./x.js` and `./x` compare equal. */
function withoutSourceExtension(path: string): string {
	return path.replace(/\.(?:[cm]?[jt]s|tsx|jsx)$/, "");
}

/** Absolute paths (extension stripped) of the relative modules `program` imports at run time. A type-only import cannot throw, so it is skipped. No connector reaches a shared module through a re-export or a dynamic `import()`, so those are not followed. */
function runtimeImportedPaths(program: Node, absPath: string): string[] {
	const paths: string[] = [];
	for (const statement of (program as { body?: Node[] }).body ?? []) {
		const { importKind, source } = statement as {
			importKind?: string;
			source?: Node;
		};
		if (
			statement.type === "ImportDeclaration" &&
			importKind !== "type" &&
			source &&
			isStringLiteral(source) &&
			source.value.startsWith(".")
		) {
			paths.push(
				withoutSourceExtension(resolve(dirname(absPath), source.value)),
			);
		}
	}
	return paths;
}

/** The shared modules whose terminal codes belong to a connector that imports `importedPaths` (directly, or through a module in `reachedThrough`). */
function attributedSharedModules(
	importedPaths: ReadonlySet<string>,
	sharedModules: readonly SharedTerminalCodeModule[],
): SharedTerminalCodeModule[] {
	const imports = (path: string): boolean =>
		importedPaths.has(withoutSourceExtension(path));
	return sharedModules.filter(
		(shared) => imports(shared.path) || shared.reachedThrough.some(imports),
	);
}

/**
 * Resolves and records every `reason:` property of one already-confirmed
 * emission object literal, pushing into `ctx`'s literalReasons/unresolved
 * accumulators.
 *
 * A `SpreadElement` is only a completeness risk when this object has NO OWN
 * literal `reason:` property — that's the only shape where the spread could
 * be the sole source of `reason` (`{ type: "SKIP_RESULT", stream,
 * ...outcome.skip }`, the google_messages pattern, where `outcome.skip` is
 * `{ reason: string; message: string } | undefined`). A spread that
 * contributes some OTHER field alongside an own literal `reason:` (usaa's
 * `{ type: "SKIP_RESULT", reason: "session_dead_reauth_failed", message,
 * ...(diagnostic ? { diagnostics: {...} } : {}) }`, where the spread only
 * ever adds `diagnostics`) is provably irrelevant to `reason` and must not
 * be flagged — an own literal `reason:` property always wins JS's
 * last-key-wins spread semantics only if the spread appears BEFORE it in
 * source order; this scanner does not attempt to reason about spread/key
 * ordering (a spread placed AFTER an own `reason:` property could in
 * principle override it) because no real emission site in this codebase
 * does that — the two live shapes are "spread is the only source" (flag)
 * and "spread never touches reason" (own `reason:` present, ignore) — so
 * checking "does an own literal `reason:` property exist at all" is the
 * bound that actually needs to hold today, not "did the spread come first."
 * Resolving through a flagged spread would need a further hop into the
 * spread source's own shape (a same-file variable's initializer, then that
 * initializer's own possibly-multi-branch return shape) — deeper
 * indirection than any other resolution path in this file handles. Rather
 * than grow the bound to chase it, this stays fail-closed: reported as
 * `unresolved`, one entry per spread, never silently skipped.
 */
function recordEmissionObjectReasons(
	n: ObjectExpressionNode,
	enclosingFunction: Node | null,
	ctx: ScanContext,
): void {
	const hasOwnReasonProperty = n.properties.some(
		(prop) =>
			isObjectProperty(prop) && objectPropertyKeyName(prop) === "reason",
	);

	for (const prop of n.properties) {
		if (isSpreadElement(prop)) {
			if (!hasOwnReasonProperty) {
				ctx.unresolved.push(scanLocation(prop, ctx));
			}
			continue;
		}
		if (objectPropertyKeyName(prop) !== "reason" || !isObjectProperty(prop)) {
			continue;
		}
		const resolved = resolveReasonValue(
			prop.value,
			ctx.program,
			enclosingFunction,
		);
		if (resolved) {
			ctx.literalReasons.push(...resolved);
		} else {
			ctx.unresolved.push(scanLocation(prop.value, ctx));
		}
	}
}

/** Walks every child of one AST node, recursing with the (possibly updated) enclosing-function scope. */
function walkChildrenWithFunctionScope(
	n: Node,
	nextEnclosing: Node | null,
	ctx: ScanContext,
): void {
	for (const key of Object.keys(n)) {
		if (key === "loc" || key === "start" || key === "end" || key === "range") {
			continue;
		}
		const child = (n as Record<string, unknown>)[key];
		if (child && typeof child === "object") {
			walkWithFunctionScope(child, nextEnclosing, ctx);
		}
	}
}

/** Walks the AST tracking the innermost enclosing function, so an identifier resolution (in resolveReasonValue) knows which function scope to search for a local initializer. */
function walkWithFunctionScope(
	node: unknown,
	enclosingFunction: Node | null,
	ctx: ScanContext,
): void {
	if (!node || typeof node !== "object") {
		return;
	}
	if (Array.isArray(node)) {
		for (const item of node) {
			walkWithFunctionScope(item, enclosingFunction, ctx);
		}
		return;
	}
	const n = node as Node;
	const nextEnclosing =
		typeof n.type === "string" && FUNCTION_NODE_TYPES.has(n.type)
			? n
			: enclosingFunction;

	if (isObjectExpression(n) && isEmissionObjectLiteral(n)) {
		recordEmissionObjectReasons(n, nextEnclosing, ctx);
	}
	if (typeof n.type === "string") {
		recordTerminalCodeSite(n, nextEnclosing, ctx);
	}

	walkChildrenWithFunctionScope(n, nextEnclosing, ctx);
}

/**
 * Scans every production file in a connector's directory, plus the terminal
 * codes of each shared module it imports (`sharedModules`, defaulting to
 * `SHARED_TERMINAL_CODE_MODULES`). A shared module contributes only terminal
 * codes: its `reason:` emissions, if any, are not this connector's.
 */
export function scanConnectorForReasonEmissions(
	connectorDir: string,
	sharedModules: readonly SharedTerminalCodeModule[] = SHARED_TERMINAL_CODE_MODULES,
): ReasonEmissionScanResult {
	const literalReasons = new Set<string>();
	const terminalCodes = new Set<string>();
	const unresolved: ScanLocation[] = [];
	const unresolvedTerminalCodes: ScanLocation[] = [];
	const importedPaths = new Set<string>();
	for (const file of connectorProductionFiles(connectorDir)) {
		const scanned = scanSourceFile(file);
		for (const code of scanned.result.literalReasons) {
			literalReasons.add(code);
		}
		for (const code of scanned.result.terminalCodes) {
			terminalCodes.add(code);
		}
		unresolved.push(...scanned.result.unresolved);
		unresolvedTerminalCodes.push(...scanned.result.unresolvedTerminalCodes);
		for (const path of scanned.importedPaths) {
			importedPaths.add(path);
		}
	}
	for (const shared of attributedSharedModules(importedPaths, sharedModules)) {
		const result = scanFileForReasonEmissions(shared.path);
		for (const code of result.terminalCodes) {
			terminalCodes.add(code);
		}
		unresolvedTerminalCodes.push(...result.unresolvedTerminalCodes);
	}
	return {
		literalReasons: [...literalReasons],
		terminalCodes: [...terminalCodes],
		unresolved,
		unresolvedTerminalCodes,
	};
}
