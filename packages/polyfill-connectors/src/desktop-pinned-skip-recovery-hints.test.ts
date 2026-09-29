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

/** Same-file definitions that a hint expression may resolve through, one
 *  hop: function bodies by name, and every value assigned to a property by
 *  that property's name. */
interface FileScope {
	functions: Map<string, Node>;
	propertyValues: Map<string, Node[]>;
}

/** Every string literal assigned to an `action` key under `node`, or returned
 *  as a bare string. A call to a same-file function resolves to its body.
 *  `x.recoveryHint` resolves to every `recoveryHint:` value in the file. */
function hintActions(node: Node, scope: FileScope, hop = 0): string[] {
	if (node.type === "StringLiteral") {
		return [node.value as string];
	}
	if (
		hop === 0 &&
		node.type === "CallExpression" &&
		(node.callee as Node).type === "Identifier"
	) {
		const fn = scope.functions.get((node.callee as Node).name as string);
		return fn ? hintActions(fn, scope, 1) : [];
	}
	if (
		hop === 0 &&
		node.type === "MemberExpression" &&
		(node.property as Node).type === "Identifier"
	) {
		const values =
			scope.propertyValues.get((node.property as Node).name as string) ?? [];
		return values.flatMap((value) => hintActions(value, scope, 1));
	}
	const actions: string[] = [];
	walk(node, (inner) => {
		if (inner.type === "ObjectProperty" && propertyName(inner) === "action") {
			const value = inner.value as Node;
			if (value.type === "StringLiteral") {
				actions.push(value.value as string);
			}
		}
	});
	return actions;
}

interface SkipSite {
	file: string;
	line: number;
	actions: string[] | null;
}

function scanSkipSites(file: string): SkipSite[] {
	const source = readFileSync(file, "utf8");
	const ast = parse(source, {
		plugins: ["typescript", "jsx"],
		sourceType: "module",
	}) as unknown as Node;
	const scope: FileScope = { functions: new Map(), propertyValues: new Map() };
	walk(ast, (node) => {
		if (node.type === "FunctionDeclaration" && isNode(node.id)) {
			scope.functions.set(node.id.name as string, node.body as Node);
		}
		if (node.type === "ObjectProperty" && isNode(node.value)) {
			const name = propertyName(node);
			if (name) {
				const values = scope.propertyValues.get(name) ?? [];
				values.push(node.value);
				scope.propertyValues.set(name, values);
			}
		}
	});
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
			actions: hint ? hintActions(hint.value as Node, scope) : null,
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
