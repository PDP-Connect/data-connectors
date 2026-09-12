// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The host-runtime contract: the written-down, versioned answer to "which bytes
 * ship inside a connector artifact, and which capabilities does the supported
 * runtime provide?"
 *
 * Before this file existed the builder left EVERY npm dependency external and
 * recorded, as provenance, values like `file:./vendor/pdpp-connector-protocol-0.0.1.tgz`
 * — a path relative to THIS repository. A consumer cannot install that. The
 * verifier hid the gap by symlinking its scratch install's node_modules at the
 * publisher's own node_modules, which proves the bundle runs against the
 * publisher's checkout and proves nothing about a release.
 *
 * The rule now has two halves, and both are enforced rather than assumed:
 *
 *   1. Anything statically reachable from the entrypoint is BUNDLED. If the
 *      module graph reaches it at load time, its bytes travel in code.tar.gz.
 *   2. Anything left external must appear in HOST_PROVIDED below, must be
 *      reached only through a dynamic import, and is therefore never needed to
 *      load the module — only to perform an operation the host already had to
 *      provision.
 *
 * A static import of a host-provided package is a CONTRACT VIOLATION and fails
 * the build, because it would make module loading depend on bytes the artifact
 * does not carry. That is precisely the failure this contract exists to stop.
 *
 * Why these packages. Most are here because they are genuinely host-coupled:
 * bundling patchright's JavaScript would not help, because the thing it needs
 * is a downloaded Chromium install and a matching host OS — bytes an artifact
 * cannot carry in any useful sense (the design explicitly does not bundle an
 * OS) — and better-sqlite3 is a compiled native addon for the host's ABI.
 * Shipping the per-platform tool layer is tracked as separate work.
 *
 * imapflow is the exception and is labelled as one below, because an entry
 * whose stated reason is false is worse than no entry: it stops anyone
 * rechecking. It is bundleable, it is listed only until the bundler grows a
 * createRequire banner, and the reason recorded against it says so.
 *
 * Until an entry is removed, a connector that STATICALLY needs any of these
 * fails the build by name.
 */

import { builtinModules } from "node:module";

/**
 * Bumped when the set below changes meaning. The builder stamps it into
 * config.json and provenance.json so an installed artifact records which
 * contract it was published under, rather than leaving a consumer to guess.
 */
export const HOST_RUNTIME_CONTRACT_VERSION = "1.0";

/**
 * Packages the supported runtime provides. Each entry states why it cannot be
 * bundled — an unexplained entry is how an allowlist quietly becomes a
 * description of whatever happens to be installed.
 */
export const HOST_PROVIDED = new Map([
	[
		"patchright",
		"Browser automation driver. Needs a downloaded Chromium build and a matching host OS, which an artifact cannot carry; bundling the JS alone would not make it runnable.",
	],
	[
		"playwright",
		"Browser automation driver, same constraint as patchright.",
	],
	[
		"better-sqlite3",
		"Compiled native addon built against the host's Node ABI. Requires the per-platform tool layer, which is not implemented.",
	],
	[
		"imapflow",
		"CommonJS IMAP client, listed here pending the bundler change that would remove it. NOT a native or host-coupled dependency: the earlier reason recorded here — that its pino/thread-stream/sonic-boom tree resolves modules through runtime require() and worker threads — was wrong, and execution contradicts it. The 'Dynamic require is not supported' failure is an esbuild ESM-output artifact over the Node builtin `tls`, not a property of imapflow. Bundling it and adding the standard createRequire banner produces a bundle that loads on a host with no node_modules and drives imapflow for real (default pino logger emits, connect() reaches a clean ECONNREFUSED); thread-stream never spawns a worker because imapflow calls bare pino() with no transport. Adopting the banner affects every connector, so it is its own change; until it lands, gmail is refused by name rather than published broken.",
	],
	[
		"canvas",
		"Optional native rendering backend that linkedom require()s behind a runtime guard (node_modules/linkedom/commonjs/canvas.cjs) and pdf-parse offers as @napi-rs/canvas. It is neither declared nor installed in this tree, so there are no bytes to bundle; linkedom degrades without it.",
	],
]);

/**
 * Node builtins, which are provided by the runtime by definition and are never
 * bundled.
 *
 * Both spellings have to be recognised. `node:fs` is the modern form, but
 * dependencies in the tree still write bare `fs`, `events` and `util` — and
 * treating those as missing packages would refuse to build a connector over
 * modules the runtime always has.
 */
export function isNodeBuiltin(specifier) {
	return (
		specifier.startsWith("node:") ||
		builtinModules.includes(specifier.split("/")[0])
	);
}

/**
 * The Node range a consuming host must provide. Read from the connector
 * package rather than restated here, so it cannot drift from what the code is
 * actually built and tested against.
 */
export function hostNodeRange(packageManifest) {
	const range = packageManifest.engines?.node;
	if (!range) {
		throw new Error(
			"packages/polyfill-connectors/package.json declares no engines.node, so the artifact cannot state which runtime it requires.",
		);
	}
	return range;
}

/**
 * Decide the verdict for the externals a finished bundle still references.
 *
 * `imports` is esbuild's metafile view, which carries the import KIND. The kind
 * is the whole point: `import x from "patchright"` and `await import("patchright")`
 * are the same package and completely different obligations. The first makes
 * loading the module impossible without those bytes; the second cannot run
 * until the host has already decided to launch a browser.
 */
export function classifyExternals(imports) {
	const violations = [];
	const hostProvided = [];

	for (const entry of imports) {
		if (isNodeBuiltin(entry.path)) continue;
		// esbuild's own injected helper module, not a package anyone installs.
		// It is emitted INTO the bundle, so it needs no contract entry.
		if (entry.path === "<runtime>") continue;
		const packageName = packageNameOf(entry.path);

		if (!HOST_PROVIDED.has(packageName)) {
			violations.push(
				`${entry.path} is left external but is not in the host-runtime contract. ` +
					"Either bundle it (it is reachable, so its bytes must ship) or add it to HOST_PROVIDED with a reason.",
			);
			continue;
		}
		// `require-call` counts alongside `dynamic-import`: esbuild reports a
		// CommonJS `require()` it could not statically inline, which — like a
		// dynamic import — does not run until the surrounding code path does.
		// linkedom's optional `require("canvas")` is the real case.
		if (entry.kind === "dynamic-import" || entry.kind === "require-call") {
			hostProvided.push({
				specifier: entry.path,
				package: packageName,
				kind: entry.kind,
			});
			continue;
		}
		violations.push(
			`${entry.path} is host-provided but is imported STATICALLY (kind '${entry.kind}'). ` +
				"That makes loading the entrypoint depend on bytes the artifact does not carry. " +
				"Use a dynamic import at the point of use, or bundle the package.",
		);
	}

	return { violations, hostProvided: dedupe(hostProvided) };
}

export function packageNameOf(specifier) {
	return specifier.startsWith("@")
		? specifier.split("/").slice(0, 2).join("/")
		: specifier.split("/")[0];
}

function dedupe(entries) {
	const seen = new Map();
	for (const entry of entries) seen.set(entry.specifier, entry);
	return [...seen.values()].sort((a, b) =>
		a.specifier.localeCompare(b.specifier),
	);
}
