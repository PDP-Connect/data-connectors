// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Syntax-aware count of full-inventory completion claims in one source file,
 * for `full-inventory-coverage-guard.test.ts`. A claim is either:
 *
 *   - `full_scan`: a call of `buildFullScanCoverageMessage`;
 *   - `self_coverage`: a DETAIL_COVERAGE whose `stream` and checkpoint stream
 *     are the same value, built through `buildDetailCoverageMessage({...})`,
 *     emitted through `emitDetailCoverage(ctx, {...})`, or written as an
 *     object literal `{ type: "DETAIL_COVERAGE", stream, state_stream }`.
 *
 * Helpers are recognised however they are reached: a named import, an import
 * alias, a `const` re-binding (of a name or of a namespace member), or a
 * namespace member call. Literal values are compared as AST values, so quote
 * style and spacing do not matter. Source that does not parse cleanly throws:
 * a partial count could hide a claim.
 *
 * `fullInventoryCoverage` is the one path that requires an `enumerated`
 * proof; these are the paths that do not.
 */

import { parse } from "@babel/parser";

export interface ClaimCounts {
	full_scan: number;
	self_coverage: number;
}

interface AstNode {
	type: string;
	[key: string]: unknown;
}

const FULL_SCAN = "buildFullScanCoverageMessage";
const BUILD_DETAIL = "buildDetailCoverageMessage";
const EMIT_DETAIL = "emitDetailCoverage";
const HELPERS: ReadonlySet<string> = new Set([
	FULL_SCAN,
	BUILD_DETAIL,
	EMIT_DETAIL,
]);

function isNode(value: unknown): value is AstNode {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { type?: unknown }).type === "string"
	);
}

function visit(node: unknown, fn: (n: AstNode) => void): void {
	if (Array.isArray(node)) {
		for (const child of node) visit(child, fn);
		return;
	}
	if (!isNode(node)) return;
	fn(node);
	for (const [key, value] of Object.entries(node))
		if (
			key !== "loc" &&
			key !== "start" &&
			key !== "end" &&
			key !== "errors" &&
			typeof value === "object"
		)
			visit(value, fn);
}

function nameOf(node: unknown): string | null {
	if (!isNode(node)) return null;
	if (node.type === "Identifier") return String(node.name);
	if (node.type === "StringLiteral") return String(node.value);
	return null;
}

/**
 * A comparable value for an expression: a string literal's value (or a
 * template literal with no expressions), otherwise the source text with
 * spacing removed.
 */
function comparableOf(node: unknown, source: string): string | null {
	if (!isNode(node)) return null;
	if (node.type === "StringLiteral") return `str:${String(node.value)}`;
	if (node.type === "TemplateLiteral") {
		const expressions = Array.isArray(node.expressions) ? node.expressions : [];
		const quasis = Array.isArray(node.quasis) ? node.quasis : [];
		if (expressions.length === 0 && quasis.length === 1) {
			const cooked = (quasis[0] as { value?: { cooked?: unknown } }).value
				?.cooked;
			if (typeof cooked === "string") return `str:${cooked}`;
		}
	}
	return `src:${source.slice(Number(node.start), Number(node.end)).replace(/\s+/g, "")}`;
}

function property(object: AstNode, keyName: string): unknown {
	const properties = Array.isArray(object.properties) ? object.properties : [];
	for (const entry of properties)
		if (
			isNode(entry) &&
			entry.type === "ObjectProperty" &&
			nameOf(entry.key) === keyName
		)
			return entry.value;
	return undefined;
}

export function scanFullInventoryClaims(source: string): ClaimCounts {
	let ast: unknown;
	try {
		ast = parse(source, {
			errorRecovery: true,
			plugins: ["typescript"],
			sourceType: "module",
		});
	} catch (error) {
		throw new Error(
			`full-inventory claim scan: source could not be parsed (${String(error)})`,
		);
	}
	const errors = (ast as { errors?: unknown[] }).errors ?? [];
	if (errors.length > 0)
		throw new Error(
			`full-inventory claim scan: source could not be parsed (${String(errors[0])})`,
		);

	const counts: ClaimCounts = { full_scan: 0, self_coverage: 0 };
	const aliases = new Map<string, string>(
		[...HELPERS].map((helper) => [helper, helper]),
	);
	const namespaces = new Set<string>();
	visit(ast, (node) => {
		if (node.type === "ImportSpecifier") {
			const imported = nameOf(node.imported);
			const local = nameOf(node.local);
			if (imported && local && HELPERS.has(imported))
				aliases.set(local, imported);
		} else if (node.type === "ImportNamespaceSpecifier") {
			const local = nameOf(node.local);
			if (local) namespaces.add(local);
		}
	});
	/** The helper an expression names: an alias, or a namespace member. */
	const helperOf = (expression: unknown): string | null => {
		if (!isNode(expression)) return null;
		if (expression.type === "Identifier")
			return aliases.get(String(expression.name)) ?? null;
		if (expression.type === "MemberExpression") {
			const member = nameOf(expression.property);
			if (member && HELPERS.has(member)) return member;
		}
		return null;
	};
	// Re-bindings, repeated until stable so a chain of consts resolves.
	for (let changed = true; changed; ) {
		changed = false;
		visit(ast, (node) => {
			if (node.type !== "VariableDeclarator") return;
			const target = nameOf(node.id);
			const helper = helperOf(node.init);
			if (target && helper && aliases.get(target) !== helper) {
				aliases.set(target, helper);
				changed = true;
			}
		});
	}
	const isSelfClaim = (object: unknown, stateKey: string): boolean => {
		if (!isNode(object) || object.type !== "ObjectExpression") return false;
		const stream = comparableOf(property(object, "stream"), source);
		const state = comparableOf(property(object, stateKey), source);
		return stream !== null && stream === state;
	};
	visit(ast, (node) => {
		if (node.type === "CallExpression") {
			const helper = helperOf(node.callee);
			const args = Array.isArray(node.arguments) ? node.arguments : [];
			if (helper === FULL_SCAN) counts.full_scan += 1;
			else if (helper === BUILD_DETAIL && isSelfClaim(args[0], "stateStream"))
				counts.self_coverage += 1;
			else if (helper === EMIT_DETAIL && isSelfClaim(args[1], "stateStream"))
				counts.self_coverage += 1;
		} else if (node.type === "ObjectExpression") {
			if (
				comparableOf(property(node, "type"), source) !== "str:DETAIL_COVERAGE"
			)
				return;
			if (isSelfClaim(node, "state_stream")) counts.self_coverage += 1;
		}
	});
	return counts;
}
