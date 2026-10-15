// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Syntax-aware count of full-inventory completion claims in one source file,
 * for `full-inventory-coverage-guard.test.ts`. A claim is either:
 *
 *   - `full_scan`: a call of `buildFullScanCoverageMessage`, however it is
 *     reached (named import, alias `import { x as y }`, `const y = x`, or a
 *     namespace member `ns.buildFullScanCoverageMessage(...)`), whatever the
 *     spacing before the parenthesis;
 *   - `self_coverage`: a DETAIL_COVERAGE built by hand whose `stream` and
 *     checkpoint stream are the same expression: a
 *     `buildDetailCoverageMessage({ stream: x, stateStream: x, ... })` call
 *     or an object literal `{ type: "DETAIL_COVERAGE", stream: x,
 *     state_stream: x, ... }`.
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
const DETAIL = "buildDetailCoverageMessage";

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

function propertyText(
	object: AstNode,
	keyName: string,
	source: string,
): string | null {
	const properties = Array.isArray(object.properties) ? object.properties : [];
	for (const property of properties) {
		if (!isNode(property) || property.type !== "ObjectProperty") continue;
		if (nameOf(property.key) !== keyName) continue;
		const value = property.value;
		if (!isNode(value)) return null;
		const start = Number(value.start);
		const end = Number(value.end);
		return source.slice(start, end).replace(/\s+/g, "");
	}
	return null;
}

export function scanFullInventoryClaims(source: string): ClaimCounts {
	const counts: ClaimCounts = { full_scan: 0, self_coverage: 0 };
	let ast: unknown;
	try {
		ast = parse(source, {
			errorRecovery: true,
			plugins: ["typescript"],
			sourceType: "module",
		});
	} catch {
		// Unparseable: count the plain text so it can never hide a claim.
		counts.full_scan = source.split(FULL_SCAN).length - 1;
		return counts;
	}
	const aliases = new Map<string, string>([
		[FULL_SCAN, FULL_SCAN],
		[DETAIL, DETAIL],
	]);
	const namespaces = new Set<string>();
	// Imports and simple re-bindings first, so call sites resolve aliases.
	visit(ast, (node) => {
		if (node.type === "ImportSpecifier") {
			const imported = nameOf(node.imported);
			const local = nameOf(node.local);
			if (imported && local && (imported === FULL_SCAN || imported === DETAIL))
				aliases.set(local, imported);
		} else if (node.type === "ImportNamespaceSpecifier") {
			const local = nameOf(node.local);
			if (local) namespaces.add(local);
		}
	});
	visit(ast, (node) => {
		if (node.type !== "VariableDeclarator") return;
		const target = nameOf(node.id);
		const from = nameOf(node.init);
		const resolved = from === null ? undefined : aliases.get(from);
		if (target && resolved) aliases.set(target, resolved);
	});
	const calleeName = (callee: unknown): string | null => {
		if (!isNode(callee)) return null;
		if (callee.type === "Identifier")
			return aliases.get(String(callee.name)) ?? null;
		if (callee.type === "MemberExpression") {
			const property = nameOf(callee.property);
			if (property === FULL_SCAN || property === DETAIL) return property;
		}
		return null;
	};
	visit(ast, (node) => {
		if (node.type === "CallExpression") {
			const callee = calleeName(node.callee);
			if (callee === FULL_SCAN) counts.full_scan += 1;
			else if (callee === DETAIL) {
				const args = Array.isArray(node.arguments) ? node.arguments : [];
				const first = args[0];
				if (isNode(first) && first.type === "ObjectExpression") {
					const stream = propertyText(first, "stream", source);
					const state = propertyText(first, "stateStream", source);
					if (stream !== null && stream === state) counts.self_coverage += 1;
				}
			}
		} else if (node.type === "ObjectExpression") {
			const type = propertyText(node, "type", source);
			if (type !== '"DETAIL_COVERAGE"') return;
			const stream = propertyText(node, "stream", source);
			const state = propertyText(node, "state_stream", source);
			if (stream !== null && stream === state) counts.self_coverage += 1;
		}
	});
	return counts;
}
