// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test support: finds the places where a connector source file really reports
 * an account id, by parsing it. A regex over the text counts a commented-out
 * call and misses `reportAccountIdentity (id)` or an aliased import; this scan
 * reads the syntax tree and follows each import to the module it names.
 *
 * What counts as a report: a call of `reportAccountIdentity` or
 * `requireAccountIdentity` bound by an import whose specifier resolves to
 * `src/account-identity.ts`, under any local alias or through a namespace
 * import. What counts as a direct wire emit (not allowed in a connector, which
 * must go through the single-report reporter): the string literal
 * `"ACCOUNT_IDENTITY"`.
 *
 * Parsing uses the TypeScript native API (`typescript/unstable/sync`): the
 * only parser TypeScript 7 ships for JavaScript callers.
 */

import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	type ImportDeclaration,
	isCallExpression,
	isIdentifier,
	isImportDeclaration,
	isNamedImports,
	isNamespaceImport,
	isPropertyAccessExpression,
	isStringLiteral,
	type Node,
	type SourceFile,
} from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";
import { packageRoot } from "./connector-paths.ts";

const ACCOUNT_IDENTITY_MODULE = resolve(
	packageRoot,
	"src",
	"account-identity.ts",
);
const REPORTING_EXPORTS: ReadonlySet<string> = new Set([
	"reportAccountIdentity",
	"requireAccountIdentity",
]);
const WIRE_TYPE = "ACCOUNT_IDENTITY";

export interface AccountIdentityUse {
	/** Calls of the reporter (any alias, any import form). */
	reportCalls: number;
	/** String literals that name the wire message type. */
	wireTypeLiterals: number;
}

/** True when `specifier`, written in `fromFile`, names `src/account-identity.ts`. */
function namesAccountIdentityModule(
	specifier: string,
	fromFile: string,
): boolean {
	if (!specifier.startsWith(".")) {
		return false;
	}
	const target = resolve(dirname(fromFile), specifier);
	return [target, target.replace(/\.[cm]?[jt]s$/u, ".ts")].includes(
		ACCOUNT_IDENTITY_MODULE,
	);
}

interface Bindings {
	/** Local names bound to a reporting export. */
	functions: Set<string>;
	/** Local names bound to the whole module (`import * as ns`). */
	namespaces: Set<string>;
}

function collectBindings(file: SourceFile): Bindings {
	const bindings: Bindings = { functions: new Set(), namespaces: new Set() };
	for (const statement of file.statements) {
		if (!isImportDeclaration(statement)) {
			continue;
		}
		const declaration: ImportDeclaration = statement;
		if (
			!(
				isStringLiteral(declaration.moduleSpecifier) &&
				namesAccountIdentityModule(
					declaration.moduleSpecifier.text,
					file.fileName,
				)
			)
		) {
			continue;
		}
		const named = declaration.importClause?.namedBindings;
		if (named === undefined) {
			continue;
		}
		if (isNamespaceImport(named)) {
			bindings.namespaces.add(named.name.text);
		} else if (isNamedImports(named)) {
			for (const element of named.elements) {
				if (element.isTypeOnly) {
					continue;
				}
				const imported = (element.propertyName ?? element.name).text;
				if (REPORTING_EXPORTS.has(imported)) {
					bindings.functions.add(element.name.text);
				}
			}
		}
	}
	return bindings;
}

/** What one parsed source file reports, read from its syntax tree. */
export function accountIdentityUse(file: SourceFile): AccountIdentityUse {
	const bindings = collectBindings(file);
	const use: AccountIdentityUse = { reportCalls: 0, wireTypeLiterals: 0 };
	const visit = (node: Node): void => {
		if (isStringLiteral(node) && node.text === WIRE_TYPE) {
			use.wireTypeLiterals += 1;
		}
		if (isCallExpression(node)) {
			const callee = node.expression;
			if (isIdentifier(callee) && bindings.functions.has(callee.text)) {
				use.reportCalls += 1;
			} else if (
				isPropertyAccessExpression(callee) &&
				isIdentifier(callee.expression) &&
				bindings.namespaces.has(callee.expression.text) &&
				REPORTING_EXPORTS.has(callee.name.text)
			) {
				use.reportCalls += 1;
			}
		}
		node.forEachChild(visit);
	};
	visit(file);
	return use;
}

const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
	"__fixtures__",
	"fixtures",
	"node_modules",
]);

/**
 * Every non-test `.ts` source under a connector directory, nested modules
 * included. Fixture directories hold recordings and test doubles, not the
 * connector.
 */
export function listConnectorSourceFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (!SKIPPED_DIRECTORIES.has(entry.name)) {
				files.push(...listConnectorSourceFiles(path));
			}
		} else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
			files.push(path);
		}
	}
	return files.sort();
}

/** Parses source files of one TypeScript project and reports their account-id use. */
export class AccountIdentityScanner {
	readonly #api: API;
	readonly #program: ReturnType<
		ReturnType<API["updateSnapshot"]>["getProjects"]
	>[number]["program"];

	constructor(tsconfigPath: string) {
		this.#api = new API({ cwd: dirname(tsconfigPath) });
		const project = this.#api
			.updateSnapshot({ openProject: tsconfigPath })
			.getProjects()
			.find((candidate) => resolve(candidate.configFileName) === tsconfigPath);
		if (project === undefined) {
			this.#api.close();
			throw new Error(`TypeScript could not open the project ${tsconfigPath}`);
		}
		this.#program = project.program;
	}

	/** Throws when the file is not part of the project: a file that cannot be parsed must not pass as "no calls". */
	use(fileName: string): AccountIdentityUse {
		const file = this.#program.getSourceFile(fileName);
		if (file === undefined) {
			throw new Error(`${fileName} is not part of the scanned project`);
		}
		return accountIdentityUse(file);
	}

	close(): void {
		this.#api.close();
	}
}
