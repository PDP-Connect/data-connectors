// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Builds the static import graph for polyfill-connectors with the TypeScript
 * scanner this package already installs, and exposes it as forward/reverse
 * adjacency maps.
 *
 * Deliberately NOT a third-party graph tool. An earlier revision used
 * dependency-cruiser, which cost ~4m45s of cold `npm ci` — 41 extra
 * packages, including a SECOND full TypeScript. dependency-cruiser supports
 * only `typescript >=2.0.0 <7.0.0`, while this package pins 7.0.2, so both
 * had to be installed side by side (`typescript-next: npm:typescript@^7.0.2`
 * beside a downgraded `typescript@^5.9.3`). That pushed the `verify + test`
 * job past its 10-minute budget. `typescript` is a dependency this package
 * already has, so scanning with it costs nothing extra to install.
 *
 * Scanning, not type-checking: the scanner walks tokens only — no binder, no
 * checker, no `lib.d.ts` load, no module resolution. The whole graph is an
 * O(files) text pass costing milliseconds, where a full program build would
 * cost tens of seconds.
 *
 * ## Why the `typescript/unstable/ast` entry point
 *
 * TypeScript 7 is the native (Go) port. Its default export is ONLY
 * `{ version, versionMajorMinor }` — the entire TS 5-era compiler API
 * (`ts.preProcessFile`, `ts.createSourceFile`, `ts.createProgram`) does not
 * exist on it, and `import ts from "typescript"` then reaching for any of
 * them fails at runtime, not at typecheck. The scanner is reachable only via
 * the `typescript/unstable/ast` subpath export. Two shape differences from
 * the TS 5 API that silently hang or mis-parse if assumed:
 *   - `createScanner(skipTrivia, languageVariant?, text?, ...)` takes NO
 *     leading `ScriptTarget` argument. Passing one shifts every parameter,
 *     leaving the scanner with no text and spinning forever.
 *   - The end token is `SyntaxKind.EndOfFile`, not `EndOfFileToken`. The
 *     latter is `undefined` here, so a loop comparing against it never
 *     terminates.
 * `unstable` is upstream's name for it; it is the only shipped route to a
 * scanner, and MODULE_KEYWORD_KINDS below is pinned by a test that fails
 * loudly if these kinds ever move.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
	createScanner,
	LanguageVariant,
	SyntaxKind,
} from "typescript/unstable/ast";

export interface ModuleNode {
	/** Direct static dependencies, package-relative. `dynamic` marks an `import()`/`require()` edge. */
	readonly dependencies: readonly {
		readonly resolved: string;
		readonly dynamic: boolean;
	}[];
	/** Direct static dependents (package-relative paths). */
	readonly dependents: readonly string[];
	/** Package-relative path, e.g. "src/orchestrator.ts". */
	readonly source: string;
}

export interface DependencyGraph {
	readonly modules: ReadonlyMap<string, ModuleNode>;
}

export class UntrustworthyGraphError extends Error {}

const SOURCE_ROOTS = ["bin", "connectors", "src"];
const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

/**
 * Fails closed (throws) rather than returning a graph that may have been
 * silently truncated. Callers must treat this as "the whole selector is
 * unusable right now" — the correct response is the full suite, never an
 * empty or partial one.
 *
 * The specific failure this used to guard — dependency-cruiser silently
 * returning 5 modules instead of 751 when it could not resolve a compatible
 * `typescript` — left with that dependency: the scanner is imported directly
 * here, so an unusable TypeScript is an import-time crash, not a quiet
 * under-count. What remains is the honest floor for any scanner: if source
 * roots that exist on disk yielded no parseable module at all, the walk
 * itself is broken and under-selection would otherwise be undetectable.
 *
 * The parameter keeps its `extensionsFound`/`issues` shape so the decision
 * boundary stays unit-testable against hand-built payloads (see
 * select.test.ts) without reproducing a real scan failure in a fast test.
 */
export function assertGraphIsTrustworthy(environment: {
	readonly extensionsFound: readonly {
		readonly extension: string;
		readonly available: boolean;
	}[];
	readonly issues?: readonly {
		readonly severity: string;
		readonly name: string;
	}[];
}): void {
	const tsExtension = environment.extensionsFound.find(
		(entry) => entry.extension === ".ts",
	);
	if (!tsExtension?.available) {
		throw new UntrustworthyGraphError(
			"the TypeScript import scan found no parseable .ts sources in this package " +
				"(empty, missing, or unreadable source roots). Refusing to trust the graph.",
		);
	}
	const scanIssue = (environment.issues ?? []).find(
		(issue) => issue.name === "missing-typescript-transpiler",
	);
	if (scanIssue) {
		throw new UntrustworthyGraphError(
			`the TypeScript import scan reported "${scanIssue.name}" (${scanIssue.severity}). Refusing to trust the graph.`,
		);
	}
}

function isTypeScriptSource(fileName: string): boolean {
	return (
		TS_EXTENSIONS.some((extension) => fileName.endsWith(extension)) &&
		!fileName.endsWith(".d.ts")
	);
}

/**
 * Every `.ts` source under the package's source roots, package-relative.
 *
 * Driven by SOURCE_ROOTS rather than by tsconfig's `include`/`exclude`, and
 * that difference is load-bearing: tsconfig deliberately excludes
 * `connectors/github/index.test.ts` (it imports the cross-repo reference
 * implementation, so it cannot be typechecked here). A tsconfig-driven walk
 * would drop that file, and editing `connectors/github/parsers.ts` would
 * silently stop selecting it. The selector must see every source file that
 * exists, including ones typecheck cannot process.
 */
function listSourceFiles(packageRoot: string): string[] {
	const found: string[] = [];

	function walk(dir: string): void {
		for (const entry of readdirSync(dir)) {
			if (entry === "node_modules") {
				continue;
			}
			const fullPath = join(dir, entry);
			if (statSync(fullPath).isDirectory()) {
				walk(fullPath);
			} else if (isTypeScriptSource(entry)) {
				found.push(relative(packageRoot, fullPath));
			}
		}
	}

	for (const root of SOURCE_ROOTS) {
		const rootPath = join(packageRoot, root);
		if (existsSync(rootPath)) {
			walk(rootPath);
		}
	}
	return found;
}

export interface ScannedImport {
	readonly specifier: string;
	readonly dynamic: boolean;
}

/**
 * The token kinds that can immediately precede a STATIC module specifier.
 *
 * `from` covers `import ... from "x"`, `import type ... from "x"`, `export
 * ... from "x"` and `export * from "x"`. `import` covers the bare
 * side-effect form `import "x"`.
 *
 * Matching on the PRECEDING token is what keeps ordinary string literals
 * (`const s = "./not-an-import.ts"`) out of the graph: only a specifier
 * position can follow one of these kinds.
 */
const MODULE_KEYWORD_KINDS = new Set<number>([
	SyntaxKind.FromKeyword,
	SyntaxKind.ImportKeyword,
]);

/**
 * True when a `callee ( "..." )` call is a module load — `import("x")` or
 * `require("x")` — rather than any other single-string call.
 *
 * Checking the callee is not optional precision. Treating EVERY
 * `("...")` as a module load misreads ordinary one-string calls as import
 * edges; the concrete false positive that motivated this was
 * `new URL("../../manifests/github.json", import.meta.url)` in
 * `connectors/github/setup-scopes.test.ts`, whose first argument resolves
 * to a real file and so fabricated an edge that made an unrelated test
 * appear related to `connectors/github/parsers.ts`.
 */
function isModuleCall(calleeKind: number, calleeText: string): boolean {
	if (calleeKind === SyntaxKind.ImportKeyword) {
		return true;
	}
	// The scanner gives `require` its own RequireKeyword kind rather than
	// Identifier, so match the kind first; the text check keeps this working
	// if a build ever scans it as a plain identifier instead.
	return (
		calleeKind === SyntaxKind.RequireKeyword ||
		(calleeKind === SyntaxKind.Identifier && calleeText === "require")
	);
}

/**
 * Import specifiers in one file's source text, via a pure token scan.
 *
 * A `require("x")`/`import("x")` call is reported with `dynamic: true`, but
 * note that dynamic reach is NOT what makes the selector safe — a file
 * containing any dynamic call site is forced to the full suite by
 * `fallback-inventory.ts` on the file's own text, before the graph is
 * consulted. See that module for why that check must stay textual.
 *
 * ## Why the two rescan calls are mandatory
 *
 * A raw scanner has no parser context, so two constructs are ambiguous at
 * the token level and WEDGE it — it stops advancing and re-emits the same
 * token at the same offset forever:
 *   - **Regex literals.** `/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g` is scanned
 *     as division and operators until it jams on a stray character.
 *     `reScanSlashToken()` re-reads a leading `/` as one regex token.
 *   - **Template literals.** After a `${...}` substitution, the closing `}`
 *     must be re-read as the resumption of the template
 *     (`reScanTemplateToken`), otherwise scanning continues in expression
 *     context and jams on the first `#` or other non-expression character
 *     in the literal text — e.g. a `` `# ${name}` `` heading, or the HTML
 *     `Order #` inside a fixture template string.
 * Both were observed in this exact package (11 of its 638 sources), so
 * neither branch is defensive speculation.
 *
 * Returns `null` if the scanner wedges anyway. That is a fail-closed
 * signal, not a recoverable one: a wedged scan has silently lost the rest
 * of the file's imports, and `buildDependencyGraph` must refuse the whole
 * graph rather than emit one missing edges (which would under-select tests
 * with no visible error).
 */
export function scanImports(sourceText: string): ScannedImport[] | null {
	const scanner = createScanner(true, LanguageVariant.Standard, sourceText);
	const imports: ScannedImport[] = [];

	// A two-token lookback. `previous` decides static specifiers;
	// `beforePrevious` identifies the callee of a `callee ( "..." )` call, so
	// only import()/require() produce a dynamic edge.
	let previous: number = SyntaxKind.Unknown;
	let previousText = "";
	let beforePrevious: number = SyntaxKind.Unknown;
	let beforePreviousText = "";

	let token: number = scanner.scan();
	let previousTokenEnd = -1;
	let openTemplateCount = 0;

	while (token !== SyntaxKind.EndOfFile) {
		if (
			token === SyntaxKind.SlashToken ||
			token === SyntaxKind.SlashEqualsToken
		) {
			token = scanner.reScanSlashToken();
		}
		if (token === SyntaxKind.TemplateHead) {
			openTemplateCount++;
		} else if (token === SyntaxKind.CloseBraceToken && openTemplateCount > 0) {
			token = scanner.reScanTemplateToken(false);
			if (token === SyntaxKind.TemplateTail) {
				openTemplateCount--;
			}
		}

		if (token === SyntaxKind.StringLiteral) {
			if (MODULE_KEYWORD_KINDS.has(previous)) {
				imports.push({ specifier: scanner.getTokenValue(), dynamic: false });
			} else if (
				previous === SyntaxKind.OpenParenToken &&
				isModuleCall(beforePrevious, beforePreviousText)
			) {
				imports.push({ specifier: scanner.getTokenValue(), dynamic: true });
			}
		}

		const tokenEnd = scanner.getTokenEnd();
		if (tokenEnd === previousTokenEnd) {
			return null;
		}
		previousTokenEnd = tokenEnd;

		beforePrevious = previous;
		beforePreviousText = previousText;
		previous = token;
		previousText = scanner.getTokenText();
		token = scanner.scan();
	}
	return imports;
}

/**
 * Resolves one import specifier to a package-relative path, or null if it
 * leaves this package (`node:fs`, `zod`, the cross-repo reference
 * implementation) or names nothing on disk.
 *
 * Resolution is filesystem-literal rather than a full module resolution
 * call. This package sets `allowImportingTsExtensions` and Biome's
 * `useImportExtensions` enforces it, so every in-package import already
 * names its target exactly ("./parsers.ts"); the extra candidates below only
 * cover the residual extensionless and directory-index shapes. Skipping
 * module resolution also skips its `node_modules` probing — the expensive
 * part, and irrelevant here, since an edge into `node_modules` is one this
 * graph drops anyway.
 */
export function resolveWithinPackage(
	packageRoot: string,
	fromRelativePath: string,
	specifier: string,
): string | null {
	if (!specifier.startsWith(".")) {
		return null;
	}
	const fromDir = join(packageRoot, fromRelativePath, "..");
	const target = resolve(fromDir, specifier);

	const candidates = [
		target,
		...TS_EXTENSIONS.map((extension) => `${target}${extension}`),
		...TS_EXTENSIONS.map((extension) => join(target, `index${extension}`)),
	];

	for (const candidate of candidates) {
		if (!(existsSync(candidate) && statSync(candidate).isFile())) {
			continue;
		}
		const relativePath = relative(packageRoot, candidate);
		// An import escaping the package root (e.g. into the cross-repo
		// reference implementation) is outside this graph by definition.
		if (relativePath.startsWith("..")) {
			return null;
		}
		return relativePath;
	}
	return null;
}

// biome-ignore lint/suspicious/useAwait: async is this module's published contract; callers await it.
export async function buildDependencyGraph(
	packageRoot: string,
): Promise<DependencyGraph> {
	const sourceFiles = listSourceFiles(packageRoot);

	const dependenciesBySource = new Map<
		string,
		{ resolved: string; dynamic: boolean }[]
	>();
	const dependentsBySource = new Map<string, Set<string>>();
	for (const relativePath of sourceFiles) {
		dependenciesBySource.set(relativePath, []);
		dependentsBySource.set(relativePath, new Set<string>());
	}

	for (const relativePath of sourceFiles) {
		const sourceText = readFileSync(join(packageRoot, relativePath), "utf8");
		const dependencies = dependenciesBySource.get(relativePath) ?? [];

		const scannedImports = scanImports(sourceText);
		if (scannedImports === null) {
			throw new UntrustworthyGraphError(
				`the TypeScript scanner stalled while reading "${relativePath}", so that file's ` +
					"remaining imports are unknown. Refusing to trust the graph.",
			);
		}

		for (const scanned of scannedImports) {
			const resolved = resolveWithinPackage(
				packageRoot,
				relativePath,
				scanned.specifier,
			);
			if (resolved === null) {
				continue;
			}
			dependencies.push({ resolved, dynamic: scanned.dynamic });
			dependentsBySource.get(resolved)?.add(relativePath);
		}
	}

	assertGraphIsTrustworthy({
		extensionsFound: [{ extension: ".ts", available: sourceFiles.length > 0 }],
	});

	const modules = new Map<string, ModuleNode>();
	for (const relativePath of sourceFiles) {
		modules.set(relativePath, {
			source: relativePath,
			dependents: [...(dependentsBySource.get(relativePath) ?? [])],
			dependencies: dependenciesBySource.get(relativePath) ?? [],
		});
	}
	return { modules };
}
