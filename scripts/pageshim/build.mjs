#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The `pageshim` build target: one self-contained browser IIFE per connector,
// for the Vana mobile app's PageShim host (a WebView that runs a script as
// `new AsyncFunction('page', 'process', source)`).
//
// The connector code is bundled unmodified. The seam is three things only:
//   - an entry in ./entries/ that hands the connector to ./runtime.ts, which
//     maps the PDPP protocol onto the shim's `page` API;
//   - module resolution: every Node builtin and every browser-automation
//     package resolves to a stub whose exports throw when called. `path` and
//     `url` resolve to small pure-JS versions, because connector modules call
//     them at load time;
//   - per-connector ports (CONNECTOR_PORTS): for one connector file, some
//     imports resolve to a shim that maps them onto host methods instead of
//     the throwing stub (anthropic: the export download and ZIP read).
//
// This target does not touch the OCI build (build-connector-oci-artifact.mjs).
//
// usage: node scripts/pageshim/build.mjs --connector <name> --out <file.js>

import { mkdirSync, readFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import * as esbuild from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const require = createRequire(import.meta.url);

/** Connectors enabled for the pageshim target. One entry file each. */
export const PAGESHIM_CONNECTORS = [
	"github_browser",
	"anthropic",
	"strava_browser",
	"chatgpt",
];

/**
 * Per-connector ports. `modules`: for imports made by `importer` only, these
 * specifiers resolve to a shim that maps them onto the host (instead of the
 * throwing stub or the real module). `inject`: extra globals. Unlike
 * `modules`, esbuild applies them to every free reference in the whole
 * connector bundle, not only to code under `importer`.
 */
const CONNECTOR_PORTS = {
	anthropic: {
		importer: join(REPO, "connectors", "anthropic", "index.ts"),
		shim: join(HERE, "shims", "anthropic-export.ts"),
		modules: [
			"fs",
			"fs/promises",
			"os",
			"crypto",
			"../../packages/polyfill-connectors/src/bounded-zip-archive.ts",
			"../../packages/polyfill-connectors/src/download-queue.ts",
			"../../packages/polyfill-connectors/src/playwright-download.ts",
		],
		inject: [join(HERE, "shims", "buffer.js")],
	},
};

const BROWSER_PACKAGES = [
	"playwright",
	"patchright",
	"playwright-core",
	"patchright-core",
	"chromium-bidi",
];
const PURE_SHIMS = { path: "shims/path.js", url: "shims/url.js" };
const BUILTINS = new Set(builtinModules);

function stubSource(spec) {
	let keys = [];
	try {
		keys = Object.keys(require(spec)).filter(
			(k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== "default",
		);
	} catch {}
	// Each export is a Proxy. Reading a property is allowed (modules read
	// them at load time); calling or constructing one throws and is recorded.
	return `
const hits = (globalThis.__pdppStubHits ||= []);
const mk = (path) => new Proxy(function () {}, {
  get(_t, k) {
    if (k === "then" || typeof k === "symbol") return undefined;
    return mk(path + "." + String(k));
  },
  apply() { hits.push(path + "()"); throw new Error("pageshim stub: " + path + "() is not available on this host"); },
  construct() { hits.push("new " + path); throw new Error("pageshim stub: new " + path + " is not available on this host"); },
});
export default mk(${JSON.stringify(spec)});
${keys.map((k) => `export const ${k} = mk(${JSON.stringify(`${spec}.${k}`)});`).join("\n")}
`;
}

const stubPlugin = (stubbed, port) => ({
	name: "pageshim-stubs",
	setup(build) {
		if (port) {
			build.onResolve({ filter: /.*/ }, (args) =>
				args.importer === port.importer &&
				port.modules.includes(args.path.replace(/^node:/, ""))
					? { path: port.shim }
					: undefined,
			);
		}
		build.onResolve({ filter: /^(node:)?(path|path\/posix|url)$/ }, (args) => ({
			path: join(
				HERE,
				PURE_SHIMS[args.path.replace(/^node:/, "").replace("/posix", "")],
			),
		}));
		build.onResolve({ filter: /.*/ }, (args) => {
			const bare = args.path.replace(/^node:/, "");
			const isBuiltin = args.path.startsWith("node:") || BUILTINS.has(bare);
			if (!isBuiltin && !BROWSER_PACKAGES.includes(bare.split("/")[0]))
				return undefined;
			stubbed.add(bare);
			return { path: bare, namespace: "pageshim-stub" };
		});
		build.onLoad({ filter: /.*/, namespace: "pageshim-stub" }, (args) => ({
			contents: stubSource(args.path),
			loader: "js",
		}));
	},
});

/** Builds one connector. Returns size and the list of stubbed modules. */
export async function buildPageshim({ connector, outfile, minify = true, sinceDays = 0 }) {
	if (!PAGESHIM_CONNECTORS.includes(connector)) {
		throw new Error(`pageshim target is not enabled for ${connector}`);
	}
	if (!Number.isSafeInteger(sinceDays) || sinceDays < 0) {
		throw new Error("sinceDays must be a non-negative integer");
	}
	const stubbed = new Set();
	const port = CONNECTOR_PORTS[connector];
	await esbuild.build({
		entryPoints: [join(HERE, "entries", `${connector}.ts`)],
		bundle: true,
		platform: "browser",
		format: "iife",
		target: "es2022",
		outfile,
		minify,
		legalComments: "none",
		logLevel: "warning",
		// The host passes a frozen `process = {env: {}}`. Bundled Node code
		// reads more than that, so every reference goes to a bundle-local copy.
		inject: [join(HERE, "shims", "process.js"), ...(port?.inject ?? [])],
		define: {
			"import.meta.url": '"file:///pageshim/bundle.js"',
			PAGESHIM_SINCE_DAYS: String(sinceDays),
			// The export's `version` is the connector manifest's semver.
			PAGESHIM_CONNECTOR_VERSION: JSON.stringify(
				JSON.parse(
					readFileSync(
						join(REPO, "connectors", connector, "manifest.json"),
						"utf8",
					),
				).version,
			),
		},
		plugins: [stubPlugin(stubbed, port)],
		// The host `return`s the LAST top-level `(async () => {` IIFE, so the
		// run's promise must be that IIFE.
		footer: {
			js: "\n(async () => {\n  await globalThis.__pageshimMain(page);\n})();\n",
		},
	});
	const bytes = readFileSync(outfile);
	return {
		connector,
		outfile,
		bytes: bytes.length,
		gzipBytes: gzipSync(bytes).length,
		stubbed: [...stubbed].sort(),
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({
		options: {
			connector: { type: "string" },
			out: { type: "string" },
			"since-days": { type: "string" },
		},
	});
	if (!values.connector || !values.out) {
		console.error("usage: build.mjs --connector <name> --out <file.js>");
		process.exit(2);
	}
	mkdirSync(dirname(values.out), { recursive: true });
	const report = await buildPageshim({
		connector: values.connector,
		outfile: values.out,
		sinceDays: values["since-days"] ? Number(values["since-days"]) : 0,
	});
	console.log(
		JSON.stringify({ ...report, outfile: relative(REPO, report.outfile) }),
	);
}
