// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every SKIP_RESULT that a Desktop-pinned connector emits must declare an
 * honest `recovery_hint` from the spec's closed vocabulary
 * (spec-collection-profile.md, "Recovery hints").
 *
 * Desktop is moving to a rule where a stream skip is final only when its hint
 * says `not_retriable`, and a missing hint keeps the request open. Under that
 * rule a missing hint is not neutral: it hides whether the owner, the runtime,
 * or a connector upgrade must act. So a pinned connector may not leave the
 * hint out, and may not use an action outside the vocabulary (for example the
 * old `terminal`, which the runtime must reject as a protocol violation).
 *
 * The scan is static (AST over each connector's production files), so it
 * covers every emit site, including branches no fixture reaches.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parse } from "@babel/parser";
import { connectorsDir } from "./connector-paths.ts";
import { connectorProductionFiles } from "./reason-emission-scan.ts";

const CONNECTORS_DIR = connectorsDir;

/** Connector directories behind the ids in unity-surfaces
 *  apps/desktop/pdpp-admission.json (branch pdpp-connector-cutover). Keep in
 *  sync when Desktop pins a new connector. */
const DESKTOP_PINNED_CONNECTOR_DIRS = [
	"anthropic",
	"chatgpt",
	"doordash",
	"github_browser",
	"heb",
	"icloud_notes",
	"linkedin",
	"loom",
	"meta",
	"netflix_export",
	"oura",
	"oura_browser",
	"shopify",
	"spotify",
	"strava",
	"uber",
	"wholefoods",
	"whoop",
	"youtube",
] as const;

const RECOVERY_ACTIONS = new Set([
	"retry_by_runtime",
	"retry_on_connector_upgrade",
	"refresh_credentials",
	"manual_action_required",
	"update_selector",
	"upstream_unblock",
	"not_retriable",
	"unknown",
]);

type Node = { type: string; [key: string]: unknown };

function isNode(value: unknown): value is Node {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { type?: unknown }).type === "string"
	);
}

function children(node: Node): Node[] {
	const out: Node[] = [];
	for (const [key, value] of Object.entries(node)) {
		if (
			key === "loc" ||
			key === "leadingComments" ||
			key === "trailingComments"
		) {
			continue;
		}
		if (Array.isArray(value)) {
			out.push(...value.filter(isNode));
		} else if (isNode(value)) {
			out.push(value);
		}
	}
	return out;
}

function walk(node: Node, visit: (node: Node) => void): void {
	visit(node);
	for (const child of children(node)) {
		walk(child, visit);
	}
}

function propertyName(prop: Node): string | null {
	const key = prop.key as Node | undefined;
	if (!key) {
		return null;
	}
	if (key.type === "Identifier") {
		return key.name as string;
	}
	if (key.type === "StringLiteral") {
		return key.value as string;
	}
	return null;
}

function property(object: Node, name: string): Node | undefined {
	return (object.properties as Node[]).find(
		(prop) => prop.type === "ObjectProperty" && propertyName(prop) === name,
	);
}

/** A deliberately finite resolver, not a TypeScript evaluator. Unknown values,
 * incomplete return paths and ambiguous ownership poison the whole result. */
interface LexicalScope {
	parent?: LexicalScope;
	functionBoundary?: boolean;
	bindings: Map<string, Binding | null>;
}
interface Binding {
	id: Node;
	kind: string;
	value: Node | undefined;
	fn: Node | undefined;
	index: number | undefined;
	refs: Node[];
}
interface Value {
	node: Node;
	env: Map<Binding, Value>;
}

function makeHintResolver(ast: Node): (node: Node) => string[] {
	const parents = new Map<Node, Node>();
	const scopes = new Map<Node, LexicalScope>();
	const declarations = new Set<Node>();
	const bindings: Binding[] = [];
	const nodes: Node[] = [];
	const isFunction = (node: Node) =>
		[
			"FunctionDeclaration",
			"FunctionExpression",
			"ArrowFunctionExpression",
			"ObjectMethod",
			"ClassMethod",
		].includes(node.type);
	const unwrap = (node: Node): Node =>
		[
			"TSAsExpression",
			"TSSatisfiesExpression",
			"TSNonNullExpression",
			"ParenthesizedExpression",
			"AwaitExpression",
		].includes(node.type)
			? unwrap((node.expression as Node) ?? (node.argument as Node))
			: node;
	const add = (
		scope: LexicalScope,
		id: Node,
		kind: string,
		value?: Node,
		fn?: Node,
		index?: number,
	) => {
		if (id.type !== "Identifier") {
			// Destructuring is unsupported, but must still shadow outer names.
			walk(id, (part) => {
				if (part.type === "Identifier") add(scope, part, "unknown");
			});
			return;
		}
		declarations.add(id);
		const binding: Binding = { id, kind, value, fn, index, refs: [] };
		const name = id.name as string;
		scope.bindings.set(name, scope.bindings.has(name) ? null : binding);
		bindings.push(binding);
	};
	const build = (node: Node, outer: LexicalScope, parent?: Node): void => {
		if (parent) parents.set(node, parent);
		if (
			node.type.startsWith("TS") &&
			![
				"TSAsExpression",
				"TSSatisfiesExpression",
				"TSNonNullExpression",
			].includes(node.type)
		)
			return;
		if (node.type === "FunctionDeclaration" && isNode(node.id))
			add(outer, node.id, "function", node);
		let scope = outer;
		if (
			isFunction(node) ||
			[
				"BlockStatement",
				"CatchClause",
				"ForStatement",
				"ForOfStatement",
				"ForInStatement",
				"SwitchStatement",
			].includes(node.type)
		)
			scope = {
				parent: outer,
				bindings: new Map(),
				functionBoundary: isFunction(node),
			};
		scopes.set(node, scope);
		nodes.push(node);
		if (isFunction(node)) {
			if (node.type === "FunctionExpression" && isNode(node.id))
				add(scope, node.id, "function", node);
			(node.params as Node[]).forEach((id, index) => {
				add(scope, id, "parameter", undefined, node, index);
			});
		}
		if (node.type === "CatchClause" && isNode(node.param))
			add(scope, node.param, "unknown");
		if (node.type === "VariableDeclaration") {
			let target = scope;
			if (node.kind === "var")
				while (!target.functionBoundary && target.parent)
					target = target.parent;
			for (const decl of node.declarations as Node[])
				add(
					target,
					decl.id as Node,
					node.kind as string,
					isNode(decl.init) ? decl.init : undefined,
				);
		}
		if (
			[
				"ImportSpecifier",
				"ImportDefaultSpecifier",
				"ImportNamespaceSpecifier",
			].includes(node.type)
		)
			add(scope, node.local as Node, "unknown");
		if (node.type === "ClassDeclaration" && isNode(node.id))
			add(scope, node.id, "unknown");
		for (const child of children(node)) build(child, scope, node);
	};
	build(ast, { bindings: new Map(), functionBoundary: true });
	const lookup = (node: Node): Binding | undefined => {
		for (let scope = scopes.get(node); scope; scope = scope.parent) {
			if (scope.bindings.has(node.name as string))
				return scope.bindings.get(node.name as string) ?? undefined;
		}
		return undefined;
	};
	for (const node of nodes) {
		if (node.type !== "Identifier" || declarations.has(node)) continue;
		const parent = parents.get(node);
		if (
			!parent ||
			((parent.type === "MemberExpression" ||
				parent.type === "OptionalMemberExpression") &&
				parent.property === node &&
				!parent.computed) ||
			((parent.type === "ObjectProperty" || isFunction(parent)) &&
				parent.key === node &&
				!parent.computed)
		)
			continue;
		lookup(node)?.refs.push(node);
	}
	const ownerFunction = (node: Node): Node | undefined => {
		for (let p = parents.get(node); p; p = parents.get(p))
			if (isFunction(p)) return p;
		return undefined;
	};
	const inside = (node: Node, ancestor: Node): boolean => {
		for (let p: Node | undefined = node; p; p = parents.get(p))
			if (p === ancestor) return true;
		return false;
	};
	const terminalOtherBranch = (ref: Node, use: Node): boolean => {
		if (ownerFunction(ref) !== ownerFunction(use)) return false;
		for (let p = parents.get(ref); p; p = parents.get(p)) {
			if (p.type !== "BlockStatement" || inside(use, p)) continue;
			const owner = parents.get(p);
			const last = (p.body as Node[]).at(-1);
			if (
				owner?.type === "IfStatement" &&
				last &&
				["ReturnStatement", "ThrowStatement"].includes(last.type)
			)
				return true;
		}
		return false;
	};
	const functionOf = (node: Node): Node | undefined => {
		const value = unwrap(node);
		if (isFunction(value)) return value;
		if (value.type !== "Identifier") return undefined;
		const binding = lookup(value);
		return binding &&
			["const", "function"].includes(binding.kind) &&
			binding.value &&
			isFunction(unwrap(binding.value))
			? unwrap(binding.value)
			: undefined;
	};
	const closedCalls = (fn: Node): Node[] | null => {
		const binding = bindings.find((candidate) => candidate.value === fn);
		if (!binding || parents.get(fn)?.type.startsWith("Export")) return null;
		const calls: Node[] = [];
		for (const ref of binding.refs) {
			const p = parents.get(ref);
			if (p?.type !== "CallExpression" || p.callee !== ref) return null;
			if ((p.arguments as Node[]).some((arg) => arg.type === "SpreadElement"))
				return null;
			calls.push(p);
		}
		return calls.length ? calls : null;
	};
	const immutable = (
		binding: Binding,
		use: Node,
		seen = new Set<Binding>(),
		allowTerminal = true,
		member?: string,
	): boolean => {
		if (seen.has(binding)) return false;
		seen = new Set(seen).add(binding);
		if (!["const", "function", "parameter"].includes(binding.kind))
			return false;
		for (const ref of binding.refs) {
			let top = ref;
			let p = parents.get(top);
			while (
				p &&
				(p.type === "MemberExpression" ||
					p.type === "OptionalMemberExpression") &&
				p.object === top
			) {
				top = p;
				p = parents.get(top);
			}
			if (
				p &&
				((p.type === "AssignmentExpression" && p.left === top) ||
					p.type === "UpdateExpression" ||
					(p.type === "UnaryExpression" && p.operator === "delete"))
			)
				return false;
			if (top !== ref && p?.type === "CallExpression" && p.callee === top)
				return false;
			if (ref === use) continue;
			// Reading another property of the same object neither changes nor exposes `member`.
			const read = parents.get(ref);
			if (
				member !== undefined &&
				read?.type === "MemberExpression" &&
				read.object === ref &&
				!read.computed &&
				(read.property as Node).name !== member
			)
				continue;
			if (
				allowTerminal &&
				ownerFunction(binding.id) === ownerFunction(use) &&
				terminalOtherBranch(ref, use)
			)
				continue;
			if (
				p?.type === "CallExpression" &&
				p.callee === ref &&
				binding.value &&
				isFunction(unwrap(binding.value))
			)
				continue;
			if (p?.type === "ObjectProperty" && propertyName(p) === "recovery_hint") {
				const object = parents.get(p);
				if (
					object?.type === "ObjectExpression" &&
					(property(object, "type")?.value as Node)?.value === "SKIP_RESULT"
				)
					continue;
			}
			if (
				p?.type === "ReturnStatement" &&
				ownerFunction(binding.id) === ownerFunction(ref) &&
				ownerFunction(ref)
			)
				continue;
			if (p?.type === "VariableDeclarator" && p.init === top && isNode(p.id)) {
				const alias = lookup(p.id);
				if (alias && immutable(alias, use, seen, allowTerminal)) continue;
			}
			if (
				top !== ref &&
				p &&
				[
					"BinaryExpression",
					"UnaryExpression",
					"IfStatement",
					"SwitchStatement",
				].includes(p.type)
			)
				continue;
			if (p?.type === "CallExpression") {
				const fn = functionOf(p.callee as Node);
				const index = (p.arguments as Node[]).indexOf(top);
				const parameter =
					fn && bindings.find((b) => b.fn === fn && b.index === index);
				if (parameter && immutable(parameter, use, seen, false)) continue;
			}
			return false;
		}
		return true;
	};
	const owned = (node: Node): Node[] => {
		const result: Node[] = [];
		const visit = (part: Node) => {
			result.push(part);
			if (part !== node && isFunction(part)) return;
			for (const child of children(part)) visit(child);
		};
		visit(node);
		return result;
	};
	const recursive = (fn: Node, path = new Set<Node>()): boolean => {
		if (path.has(fn)) return true;
		const next = new Set(path).add(fn);
		return owned(fn.body as Node).some((node) => {
			if (node.type !== "CallExpression") return false;
			const callee = functionOf(node.callee as Node);
			return callee ? recursive(callee, next) : false;
		});
	};
	type Flow = { returns: Node[]; falls: boolean; valid: boolean };
	const sequence = (statements: Node[]): Flow => {
		let result: Flow = { returns: [], falls: true, valid: true };
		for (const statement of statements) {
			if (!result.falls) break;
			const next = flow(statement);
			result = {
				returns: [...result.returns, ...next.returns],
				falls: next.falls,
				valid: result.valid && next.valid,
			};
		}
		return result;
	};
	const flow = (node: Node): Flow => {
		if (node.type === "ReturnStatement")
			return {
				returns: isNode(node.argument) ? [node.argument] : [],
				falls: false,
				valid: isNode(node.argument),
			};
		if (node.type === "ThrowStatement")
			return { returns: [], falls: false, valid: true };
		if (node.type === "BlockStatement") return sequence(node.body as Node[]);
		if (node.type === "IfStatement") {
			const a = flow(node.consequent as Node);
			const b = isNode(node.alternate)
				? flow(node.alternate)
				: { returns: [], falls: true, valid: true };
			return {
				returns: [...a.returns, ...b.returns],
				falls: a.falls || b.falls,
				valid: a.valid && b.valid,
			};
		}
		if (node.type === "SwitchStatement") {
			const cases = node.cases as Node[];
			const branches = cases.map((_, index) =>
				sequence(
					cases.slice(index).flatMap((item) => item.consequent as Node[]),
				),
			);
			return {
				returns: branches.flatMap((branch) => branch.returns),
				falls:
					!cases.some((item) => item.test === null) ||
					branches.some((branch) => branch.falls),
				valid: branches.every((branch) => branch.valid),
			};
		}
		if (
			isFunction(node) ||
			node.type === "VariableDeclaration" ||
			node.type === "ExpressionStatement" ||
			node.type === "EmptyStatement"
		)
			return { returns: [], falls: true, valid: true };
		// A loop without owned returns only preprocesses inputs. Any return,
		// break/try/labeled control or other unsupported path fails closed.
		if (
			["WhileStatement", "ForStatement", "ForOfStatement"].includes(
				node.type,
			) &&
			!owned(node).some((part) => part.type === "ReturnStatement")
		)
			return { returns: [], falls: true, valid: true };
		return { returns: [], falls: true, valid: false };
	};
	const all = (groups: (Value[] | null)[]): Value[] | null => {
		const values: Value[] = [];
		for (const group of groups) {
			if (group === null) return null;
			for (const value of group) values.push(value);
		}
		return values;
	};
	const resolve = (
		input: Value,
		active: Set<Node>,
		member?: string,
	): Value[] | null => {
		const node = unwrap(input.node);
		const env = input.env;
		if (active.size > 64 || active.has(node)) return null;
		active = new Set(active).add(node);
		if (node.type === "ObjectExpression" || node.type === "StringLiteral")
			return [{ node, env }];
		if (node.type === "ConditionalExpression")
			return all([
				resolve({ node: node.consequent as Node, env }, active),
				resolve({ node: node.alternate as Node, env }, active),
			]);
		if (node.type === "Identifier") {
			const binding = lookup(node);
			if (!binding || !immutable(binding, node, undefined, true, member))
				return null;
			const assigned = env.get(binding);
			if (assigned) return resolve(assigned, active);
			if (
				binding.kind === "const" &&
				binding.value &&
				Number(binding.id.start) < Number(node.start)
			)
				return resolve({ node: binding.value, env }, active);
			if (
				binding.kind === "parameter" &&
				binding.fn &&
				binding.index !== undefined
			) {
				const index = binding.index;
				const calls = closedCalls(binding.fn);
				return (
					calls &&
					all(
						calls.map((call) => {
							const arg = (call.arguments as Node[])[index];
							return arg ? resolve({ node: arg, env }, active) : null;
						}),
					)
				);
			}
			return null;
		}
		if (
			node.type === "MemberExpression" &&
			!node.computed &&
			(node.property as Node).type === "Identifier"
		) {
			const owners = resolve(
				{ node: node.object as Node, env },
				active,
				(node.property as Node).name as string,
			);
			return (
				owners &&
				all(
					owners.map((owner) => {
						const value = ownProperty(
							owner.node,
							(node.property as Node).name as string,
						);
						return value
							? resolve({ node: value, env: owner.env }, active)
							: null;
					}),
				)
			);
		}
		if (node.type === "CallExpression") {
			const fn = functionOf(node.callee as Node);
			if (!fn || fn.async || fn.generator || active.has(fn) || recursive(fn))
				return null;
			const callee = node.callee as Node;
			const binding = callee.type === "Identifier" ? lookup(callee) : undefined;
			if (binding && !immutable(binding, callee)) return null;
			const args = node.arguments as Node[];
			if (args.some((arg) => arg.type === "SpreadElement")) return null;
			const nextEnv = new Map(env);
			for (const parameter of bindings.filter(
				(b): b is Binding & { index: number } =>
					b.fn === fn && b.index !== undefined,
			)) {
				const arg = args[parameter.index];
				if (arg) nextEnv.set(parameter, { node: arg, env });
			}
			const body = fn.body as Node;
			const result =
				body.type === "BlockStatement"
					? flow(body)
					: { returns: [body], falls: false, valid: true };
			if (!result.valid || result.falls || !result.returns.length) return null;
			return all(
				result.returns.map((value) =>
					resolve({ node: value, env: nextEnv }, new Set(active).add(fn)),
				),
			);
		}
		return null;
	};
	function ownProperty(object: Node, name: string): Node | undefined {
		if (object.type !== "ObjectExpression") return undefined;
		const props = object.properties as Node[];
		if (props.some((prop) => prop.type !== "ObjectProperty" || prop.computed))
			return undefined;
		const matches = props.filter((prop) => propertyName(prop) === name);
		const [match] = matches;
		return matches.length === 1 && match ? (match.value as Node) : undefined;
	}
	return (node) => {
		if (
			nodes.some(
				(part) =>
					part.type === "CallExpression" &&
					(part.callee as Node).type === "Identifier" &&
					(part.callee as Node).name === "eval",
			)
		)
			return [];
		const values = resolve({ node, env: new Map() }, new Set());
		if (!values?.length) return [];
		const actions: string[] = [];
		for (const value of values) {
			const action = ownProperty(value.node, "action");
			const resolved =
				action && resolve({ node: action, env: value.env }, new Set());
			if (
				!resolved?.length ||
				resolved.some((item) => item.node.type !== "StringLiteral")
			)
				return [];
			actions.push(...resolved.map((item) => item.node.value as string));
		}
		return [...new Set(actions)];
	};
}

interface SkipSite {
	file: string;
	line: number;
	actions: string[] | null;
}

function scanSkipSites(file: string): SkipSite[] {
	return scanSkipSource(file, readFileSync(file, "utf8"));
}

function scanSkipSource(file: string, source: string): SkipSite[] {
	const ast = parse(source, {
		plugins: ["typescript", "jsx"],
		sourceType: "module",
	}) as unknown as Node;
	const resolveHintActions = makeHintResolver(ast);
	const sites: SkipSite[] = [];
	walk(ast, (node) => {
		if (node.type !== "ObjectExpression") {
			return;
		}
		const typeProp = property(node, "type");
		const typeValue = typeProp?.value as Node | undefined;
		if (
			typeValue?.type !== "StringLiteral" ||
			typeValue.value !== "SKIP_RESULT"
		) {
			return;
		}
		const hint = property(node, "recovery_hint");
		sites.push({
			file: file.slice(CONNECTORS_DIR.length + 1),
			line: (node.loc as { start: { line: number } }).start.line,
			actions: hint ? resolveHintActions(hint.value as Node) : null,
		});
	});
	return sites;
}

const sites = DESKTOP_PINNED_CONNECTOR_DIRS.flatMap((dir) =>
	connectorProductionFiles(join(CONNECTORS_DIR, dir)).flatMap(scanSkipSites),
);

test("desktop-pinned connectors: the scan finds their SKIP_RESULT emits", () => {
	// Guards the scan itself: an empty result would pass the checks below
	// vacuously.
	assert.ok(sites.length >= 50, `found only ${sites.length} SKIP_RESULT sites`);
});

test("desktop-pinned connectors: every SKIP_RESULT declares a recovery_hint", () => {
	const missing = sites
		.filter((site) => site.actions === null)
		.map((site) => `${site.file}:${site.line}`);
	assert.deepEqual(missing, [], "SKIP_RESULT without recovery_hint");
});

test("desktop-pinned connectors: every recovery_hint action is in the spec vocabulary", () => {
	const bad = sites.flatMap((site) => {
		if (site.actions === null) {
			return [];
		}
		if (site.actions.length === 0) {
			return [`${site.file}:${site.line} (no literal action)`];
		}
		return site.actions
			.filter((action) => !RECOVERY_ACTIONS.has(action))
			.map((action) => `${site.file}:${site.line} (${action})`);
	});
	assert.deepEqual(bad, [], "recovery_hint action outside the vocabulary");
});

/** Independent snippets use the production scan above, not a second resolver.
 * Failures are retained as counterexamples until lexical/control-flow ownership
 * can be established without ignoring unknown branches. */
const snippetCases = [
	{
		name: "literal",
		valid: true,
		source:
			'emit({type:"SKIP_RESULT", recovery_hint:{action:"retry_by_runtime"}});',
	},
	{
		name: "local const",
		valid: true,
		source:
			'const hint={action:"retry_by_runtime"}; emit({type:"SKIP_RESULT", recovery_hint:hint});',
	},
	{
		name: "same-file function",
		valid: true,
		source:
			'function hint(){return {action:"retry_by_runtime"};} emit({type:"SKIP_RESULT", recovery_hint:hint()});',
	},
	{
		name: "parameter forwarding",
		valid: true,
		source:
			'function send(hint){emit({type:"SKIP_RESULT", recovery_hint:hint});} send({action:"retry_by_runtime"});',
	},
	{
		name: "invalid literal",
		valid: false,
		source: 'emit({type:"SKIP_RESULT", recovery_hint:{action:"terminal"}});',
	},
	{
		name: "mixed valid and unknown",
		valid: false,
		source:
			'function hint(x){if(x)return {action:"retry_by_runtime"}; return externalHint();} emit({type:"SKIP_RESULT", recovery_hint:hint(flag)});',
	},
	{ name: "missing hint", valid: false, source: 'emit({type:"SKIP_RESULT"});' },
	{
		name: "shadowed function",
		valid: false,
		source:
			'function hint(){return {action:"terminal"};} emit({type:"SKIP_RESULT", recovery_hint:hint()}); function other(){function hint(){return {action:"retry_by_runtime"};}}',
	},
	{
		name: "mutated binding",
		valid: false,
		source:
			'function hint(){const h={action:"retry_by_runtime"}; h.action=externalAction;return h;} emit({type:"SKIP_RESULT", recovery_hint:hint()});',
	},
	{
		name: "unresolved call",
		valid: false,
		source: 'emit({type:"SKIP_RESULT", recovery_hint:externalHint()});',
	},
	{
		name: "recursion",
		valid: false,
		source:
			'function hint(x){if(x)return {action:"retry_by_runtime"};return hint(x);} emit({type:"SKIP_RESULT", recovery_hint:hint(flag)});',
	},
	{
		name: "unrelated member owner",
		valid: false,
		source:
			'const other={recoveryHint:{action:"retry_by_runtime"}};emit({type:"SKIP_RESULT", recovery_hint:unknownOwner.recoveryHint});',
	},
	{
		name: "reassigned binding",
		valid: false,
		source:
			'let h={action:"retry_by_runtime"};h=externalHint();emit({type:"SKIP_RESULT",recovery_hint:h});',
	},
	{
		name: "implicit unknown return",
		valid: false,
		source:
			'function hint(x){if(x)return {action:"retry_by_runtime"};} emit({type:"SKIP_RESULT",recovery_hint:hint(flag)});',
	},
	{
		name: "different member owners",
		valid: false,
		source:
			'const good={recoveryHint:{action:"retry_by_runtime"}};const bad={recoveryHint:{action:"terminal"}};emit({type:"SKIP_RESULT",recovery_hint:bad.recoveryHint});',
	},
	{
		name: "actual member owner",
		valid: true,
		source:
			'const good={recoveryHint:{action:"retry_by_runtime"}};const bad={recoveryHint:{action:"terminal"}};emit({type:"SKIP_RESULT",recovery_hint:good.recoveryHint});',
	},
	{
		name: "unknown argument poisons forwarding",
		valid: false,
		source:
			'function send(h){emit({type:"SKIP_RESULT",recovery_hint:h});}send({action:"retry_by_runtime"});send(externalHint());',
	},
	{
		name: "exact argument position",
		valid: false,
		source:
			'function send(good,h){emit({type:"SKIP_RESULT",recovery_hint:h});}send({action:"retry_by_runtime"},{action:"terminal"});',
	},
	{
		name: "nested function does not own return",
		valid: false,
		source:
			'function hint(){function nested(){return {action:"retry_by_runtime"};}return externalHint();}emit({type:"SKIP_RESULT",recovery_hint:hint()});',
	},
	{
		name: "unknown escape",
		valid: false,
		source:
			'const h={action:"retry_by_runtime"};mutate(h);emit({type:"SKIP_RESULT",recovery_hint:h});',
	},
	{
		name: "alias mutation",
		valid: false,
		source:
			'const h={action:"retry_by_runtime"};const alias=h;alias.action="terminal";emit({type:"SKIP_RESULT",recovery_hint:h});',
	},
	{
		name: "member alias mutation",
		valid: false,
		source:
			'const owner={hint:{action:"retry_by_runtime"}};const alias=owner.hint;alias.action="terminal";emit({type:"SKIP_RESULT",recovery_hint:owner.hint});',
	},
	{
		name: "computed mutation",
		valid: false,
		source:
			'const h={action:"retry_by_runtime"};h[key]="terminal";emit({type:"SKIP_RESULT",recovery_hint:h});',
	},
	{
		name: "indirect recursion",
		valid: false,
		source:
			'function hint(){return other();}function other(){return hint();}emit({type:"SKIP_RESULT",recovery_hint:hint()});',
	},
	{
		name: "unknown spread override",
		valid: false,
		source:
			'emit({type:"SKIP_RESULT",recovery_hint:{action:"retry_by_runtime",...externalHint()}});',
	},
	{
		name: "lexical shadow parameter",
		valid: false,
		source:
			'const h={action:"retry_by_runtime"};function send(h){emit({type:"SKIP_RESULT",recovery_hint:h});}send(externalHint());',
	},
	{
		name: "same name different calls",
		valid: false,
		source:
			'function send(h){emit({type:"SKIP_RESULT",recovery_hint:h});}send(externalHint());function other(){function send(h){}send({action:"retry_by_runtime"});}',
	},
	{
		name: "switch missing default",
		valid: false,
		source:
			'function hint(x){switch(x){case 1:return {action:"retry_by_runtime"};}}emit({type:"SKIP_RESULT",recovery_hint:hint(flag)});',
	},
	{
		name: "function reassignment",
		valid: false,
		source:
			'function hint(){return {action:"retry_by_runtime"};}hint=externalHint;emit({type:"SKIP_RESULT",recovery_hint:hint()});',
	},
	{
		name: "immutable alias",
		valid: true,
		source:
			'const h={action:"retry_by_runtime"};const alias=h;emit({type:"SKIP_RESULT",recovery_hint:alias});',
	},
	{
		name: "callsite forwarding returns",
		valid: true,
		source:
			'function hint(h){return h;}emit({type:"SKIP_RESULT",recovery_hint:hint({action:"retry_by_runtime"})});',
	},
	{
		name: "complete unknown branch set",
		valid: true,
		source:
			'function hint(x){if(x)return {action:"retry_by_runtime"};return {action:"not_retriable"};}emit({type:"SKIP_RESULT",recovery_hint:hint(flag)});',
	},
	{
		name: "block var shadow ambiguity",
		valid: false,
		source:
			'const h={action:"retry_by_runtime"};function send(){if(flag){var h=externalHint();}emit({type:"SKIP_RESULT",recovery_hint:h});}send();',
	},
	{
		name: "const function",
		valid: true,
		source:
			'const hint=()=>({action:"retry_by_runtime"});emit({type:"SKIP_RESULT",recovery_hint:hint()});',
	},
	{
		name: "dynamic lexical mutation",
		valid: false,
		source:
			'const h={action:"retry_by_runtime"};eval("h.action=bad");emit({type:"SKIP_RESULT",recovery_hint:h});',
	},
	{
		name: "escaped shared argument across calls",
		valid: false,
		source:
			'const h={action:"retry_by_runtime"};function send(h){if(flag){mutate(h);return;}emit({type:"SKIP_RESULT",recovery_hint:h});}send(h);send(h);',
	},
	{
		name: "escaped outer value across functions",
		valid: false,
		source:
			'const h={action:"retry_by_runtime"};function change(){if(flag){mutate(h);return;}}change();function send(){emit({type:"SKIP_RESULT",recovery_hint:h});}send();',
	},
	{
		name: "promise is not a hint",
		valid: false,
		source:
			'async function hint(){return {action:"retry_by_runtime"};}emit({type:"SKIP_RESULT",recovery_hint:hint()});',
	},
	{
		name: "generator is not a hint",
		valid: false,
		source:
			'function* hint(){return {action:"retry_by_runtime"};}emit({type:"SKIP_RESULT",recovery_hint:hint()});',
	},
	{
		name: "sibling read keeps member owner",
		valid: true,
		source:
			'function make(){return {recoveryHint:{action:"retry_by_runtime"}, reason:"x"};} const f=make(); emit({type:"SKIP_RESULT", reason:f.reason, recovery_hint:f.recoveryHint});',
	},
	{
		name: "same member escape",
		valid: false,
		source:
			'function make(){return {recoveryHint:{action:"retry_by_runtime"}};} const f=make(); mutate(f.recoveryHint); emit({type:"SKIP_RESULT", recovery_hint:f.recoveryHint});',
	},
	{
		name: "member mutation keeps owner rejected",
		valid: false,
		source:
			'function make(){return {recoveryHint:{action:"retry_by_runtime"}, reason:"x"};} const f=make(); f.recoveryHint.action="terminal"; emit({type:"SKIP_RESULT", recovery_hint:f.recoveryHint});',
	},
] as const;
for (const fixture of snippetCases) {
	test(`recovery hint resolver snippet: ${fixture.name}`, () => {
		const found = scanSkipSource(
			join(CONNECTORS_DIR, "snippet.ts"),
			fixture.source,
		);
		assert.equal(found.length, 1);
		const [first] = found;
		assert.ok(first);
		const actions = first.actions;
		const accepted =
			actions !== null &&
			actions.length > 0 &&
			actions.every((action) => RECOVERY_ACTIONS.has(action));
		assert.equal(accepted, fixture.valid, fixture.name);
	});
}
