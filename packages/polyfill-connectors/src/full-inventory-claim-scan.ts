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
	// Bind declarations to their lexical scope before resolving any aliases.
	// A file-wide name map oscillates when nested scopes reuse an alias.
	interface Scope {
		parent?: Scope;
		hoists: boolean;
		bindings: Map<string, Binding>;
	}
	interface Binding {
		scope: Scope;
		init?: unknown;
		value?: string | null;
	}
	const root: Scope = { hoists: true, bindings: new Map() };
	const scopes = new WeakMap<AstNode, Scope>();
	const bindings: Binding[] = [];
	const bind = (
		scope: Scope,
		name: string,
		init?: unknown,
		value?: string | null,
	): void => {
		const binding: Binding = {
			scope,
			init,
			...(value === undefined ? {} : { value }),
		};
		scope.bindings.set(name, binding);
		bindings.push(binding);
	};
	// Destructured parameters/locals also shadow imports. Only plain const
	// aliases and namespace members carry helper identity.
	const bindPattern = (pattern: unknown, scope: Scope): void => {
		if (!isNode(pattern)) return;
		if (pattern.type === "Identifier")
			bind(scope, String(pattern.name), undefined, null);
		else if (pattern.type === "AssignmentPattern")
			bindPattern(pattern.left, scope);
		else if (pattern.type === "RestElement")
			bindPattern(pattern.argument, scope);
		else if (pattern.type === "ArrayPattern") {
			for (const item of (pattern.elements as unknown[]) ?? [])
				bindPattern(item, scope);
		} else if (pattern.type === "ObjectPattern") {
			for (const item of (pattern.properties as unknown[]) ?? [])
				if (isNode(item))
					bindPattern(
						item.type === "RestElement" ? item.argument : item.value,
						scope,
					);
		}
	};
	const functionTypes = new Set([
		"FunctionDeclaration",
		"FunctionExpression",
		"ArrowFunctionExpression",
		"ObjectMethod",
		"ClassMethod",
		"ClassPrivateMethod",
	]);
	const blockTypes = new Set([
		"BlockStatement",
		"CatchClause",
		"ForStatement",
		"ForInStatement",
		"ForOfStatement",
		"SwitchStatement",
		"ClassDeclaration",
		"ClassExpression",
	]);
	const collect = (node: unknown, outer: Scope, parent?: AstNode): void => {
		if (Array.isArray(node)) {
			for (const child of node) collect(child, outer, parent);
			return;
		}
		if (!isNode(node)) return;
		if (
			node.type === "FunctionDeclaration" ||
			node.type === "ClassDeclaration"
		) {
			const name = nameOf(node.id);
			if (name) bind(outer, name, undefined, null);
		}
		const isFunction = functionTypes.has(node.type);
		const scope: Scope =
			isFunction || blockTypes.has(node.type)
				? { parent: outer, hoists: isFunction, bindings: new Map() }
				: outer;
		scopes.set(node, scope);
		if (isFunction) {
			if (node.type === "FunctionExpression") bindPattern(node.id, scope);
			for (const param of (node.params as unknown[]) ?? [])
				bindPattern(param, scope);
		} else if (node.type === "CatchClause") bindPattern(node.param, scope);
		else if (node.type === "ClassExpression") bindPattern(node.id, scope);
		if (node.type === "ImportSpecifier") {
			const local = nameOf(node.local);
			const imported = nameOf(node.imported);
			if (local)
				bind(
					scope,
					local,
					undefined,
					imported && HELPERS.has(imported) ? imported : null,
				);
		} else if (node.type === "ImportNamespaceSpecifier") {
			const local = nameOf(node.local);
			if (local) bind(scope, local, undefined, "namespace");
		} else if (node.type === "ImportDefaultSpecifier") {
			bindPattern(node.local, scope);
		} else if (node.type === "VariableDeclarator") {
			let targetScope = scope;
			if (parent?.type === "VariableDeclaration" && parent.kind === "var")
				while (!targetScope.hoists && targetScope.parent)
					targetScope = targetScope.parent;
			const name = nameOf(node.id);
			if (name) {
				// The initializer resolves where it was declared, including for var.
				const binding: Binding = { scope, init: node.init };
				targetScope.bindings.set(name, binding);
				bindings.push(binding);
			} else bindPattern(node.id, targetScope);
		}
		for (const [key, child] of Object.entries(node))
			if (key !== "loc" && key !== "errors" && typeof child === "object")
				collect(child, scope, node);
	};
	collect(ast, root);

	const resolved = new Map<Binding, string | null>();
	const resolving = new Set<Binding>();
	const resolveBinding = (binding: Binding): string | null => {
		if (resolved.has(binding)) return resolved.get(binding) ?? null;
		if (resolving.has(binding))
			throw new Error("full-inventory claim scan: unresolvable alias cycle");
		resolving.add(binding);
		const value =
			binding.value !== undefined
				? binding.value
				: resolveExpression(binding.init, binding.scope);
		resolving.delete(binding);
		resolved.set(binding, value);
		return value;
	};
	const resolveExpression = (
		expression: unknown,
		scope: Scope,
	): string | null => {
		if (!isNode(expression)) return null;
		if (expression.type === "Identifier") {
			const name = String(expression.name);
			for (
				let current: Scope | undefined = scope;
				current;
				current = current.parent
			) {
				const binding = current.bindings.get(name);
				if (binding) return resolveBinding(binding);
			}
			return HELPERS.has(name) ? name : null;
		}
		if (expression.type === "MemberExpression") {
			const member = nameOf(expression.property);
			if (
				(!expression.computed ||
					(isNode(expression.property) &&
						expression.property.type === "StringLiteral")) &&
				member &&
				HELPERS.has(member) &&
				resolveExpression(expression.object, scope) === "namespace"
			)
				return member;
		}
		return null;
	};
	// Resolve each declaration once, including unused cyclic aliases: a partial
	// scan of an unresolvable source must fail closed, never return a count.
	for (const binding of bindings) resolveBinding(binding);
	const helperOf = (expression: unknown): string | null =>
		resolveExpression(
			expression,
			isNode(expression) ? (scopes.get(expression) ?? root) : root,
		);
	const isSelfClaim = (object: unknown, stateKey: string): boolean => {
		// A factored or computed config may claim self coverage. Without a
		// complete proof of its runtime properties, count it conservatively
		// rather than letting a refactor remove the claim from the ratchet.
		if (!isNode(object) || object.type !== "ObjectExpression") return true;
		// Spreads can supply or overwrite either identity, including when
		// explicit stream/state properties otherwise appear to differ.
		const properties = Array.isArray(object.properties)
			? object.properties
			: [];
		if (
			properties.some(
				(entry) => isNode(entry) && entry.type === "SpreadElement",
			)
		)
			return true;
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
