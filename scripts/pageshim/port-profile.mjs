// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { builtinModules } from "node:module";
import { posix } from "node:path";

const PORT_PROFILE_DIRECTORY = "scripts/pageshim/ports";
const BUILTINS = new Set(builtinModules);
const MODULE_EXTENSIONS = [
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".jsx",
	".mjs",
	".cjs",
];

export class PageShimPortProfileError extends Error {}

function readRequired(readFile, path, label) {
	try {
		const content = readFile(path);
		if (content === null || content === undefined)
			throw new Error("file is missing");
		return Buffer.isBuffer(content)
			? content.toString("utf8")
			: String(content);
	} catch (error) {
		throw new PageShimPortProfileError(`${label} ${path}: ${error.message}`);
	}
}

function parseProfile(connector, readFile) {
	const path = `${PORT_PROFILE_DIRECTORY}/${connector}.json`;
	let profile;
	try {
		profile = JSON.parse(
			readRequired(readFile, path, "cannot read PageShim port profile"),
		);
	} catch (error) {
		if (error instanceof PageShimPortProfileError) throw error;
		throw new PageShimPortProfileError(
			`cannot parse PageShim port profile ${path}: ${error.message}`,
		);
	}
	if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
		throw new PageShimPortProfileError(
			`invalid PageShim port profile ${path}: expected an object`,
		);
	}
	const fields = [
		"connector",
		"importer",
		"inject",
		"modules",
		"schemaVersion",
		"shim",
	];
	if (
		Object.keys(profile).sort().join("\0") !== [...fields].sort().join("\0")
	) {
		throw new PageShimPortProfileError(
			`invalid PageShim port profile ${path}: expected fields ${fields.join(", ")}`,
		);
	}
	if (profile.schemaVersion !== 1) {
		throw new PageShimPortProfileError(
			`invalid PageShim port profile ${path}: schemaVersion must be 1`,
		);
	}
	if (profile.connector !== connector) {
		throw new PageShimPortProfileError(
			`wrong connector in PageShim port profile ${path}: expected ${connector}, got ${String(profile.connector)}`,
		);
	}
	if (
		!Array.isArray(profile.modules) ||
		!Array.isArray(profile.inject) ||
		profile.modules.some((item) => typeof item !== "string") ||
		profile.inject.some((item) => typeof item !== "string")
	) {
		throw new PageShimPortProfileError(
			`invalid PageShim port profile ${path}: modules and inject must be arrays`,
		);
	}
	return { path, profile };
}

function validateRepoPath(path, label, profilePath) {
	if (
		typeof path !== "string" ||
		path.length === 0 ||
		path.startsWith("/") ||
		path.includes("\\") ||
		path
			.split("/")
			.some((part) => part === "" || part === "." || part === "..") ||
		posix.normalize(path) !== path
	) {
		throw new PageShimPortProfileError(
			`invalid ${label} in PageShim port profile ${profilePath}: ${String(path)}`,
		);
	}
}

function resolveModulePath(importer, specifier, readFile) {
	const resolved = posix.normalize(
		posix.join(posix.dirname(importer), specifier),
	);
	if (
		resolved === ".." ||
		resolved.startsWith("../") ||
		resolved.startsWith("/")
	)
		return null;
	const extension = posix.extname(resolved);
	const candidates = extension
		? [
				resolved,
				...(extension === ".js" ? [`${resolved.slice(0, -3)}.ts`] : []),
			]
		: [
				...MODULE_EXTENSIONS.map((suffix) => `${resolved}${suffix}`),
				...MODULE_EXTENSIONS.map((suffix) => `${resolved}/index${suffix}`),
			];
	for (const candidate of candidates) {
		try {
			if (readFile(candidate) !== null) return candidate;
		} catch {}
	}
	return null;
}

/**
 * Read the selected connector's structurally valid port profile. `modules`
 * routes imports from `importer` to `shim`; `inject` supplies globals across
 * the bundle. The builder checks actual import use. `readFile` returns bytes
 * for a repository-relative path, or null when it does not exist.
 */
export function resolvePageShimPortProfile(connector, readFile) {
	if (
		typeof connector !== "string" ||
		!/^[a-z0-9][a-z0-9_]*$/.test(connector)
	) {
		throw new PageShimPortProfileError(
			`invalid PageShim connector name ${String(connector)}`,
		);
	}
	const { path, profile } = parseProfile(connector, readFile);
	const empty =
		profile.importer === null &&
		profile.shim === null &&
		profile.modules.length === 0 &&
		profile.inject.length === 0;
	if (empty) return { ...profile, path, empty: true };

	const expectedImporter = `connectors/${connector}/index.ts`;
	if (profile.importer !== expectedImporter) {
		throw new PageShimPortProfileError(
			`wrong importer in PageShim port profile ${path}: expected ${expectedImporter}, got ${String(profile.importer)}`,
		);
	}
	readRequired(
		readFile,
		profile.importer,
		"cannot read PageShim port importer",
	);
	if (typeof profile.shim !== "string") {
		throw new PageShimPortProfileError(
			`invalid shim in PageShim port profile ${path}: expected a repository path`,
		);
	}
	validateRepoPath(profile.shim, "shim path", path);
	readRequired(readFile, profile.shim, "cannot read PageShim port shim");

	// Import consumption is checked by the builder through actual esbuild onResolve callbacks.
	// This standalone resolver checks structural validity only, never source substrings.
	const seenModules = new Set();
	for (const specifier of profile.modules) {
		if (
			typeof specifier !== "string" ||
			specifier.length === 0 ||
			seenModules.has(specifier.replace(/^node:/, ""))
		) {
			throw new PageShimPortProfileError(
				`invalid or duplicate module in PageShim port profile ${path}: ${String(specifier)}`,
			);
		}
		seenModules.add(specifier.replace(/^node:/, ""));
		const normalizedSpecifier = specifier.replace(/^node:/, "");
		const bare = normalizedSpecifier;
		if (specifier.startsWith(".") || specifier.startsWith("/")) {
			if (
				specifier.startsWith("/") ||
				resolveModulePath(profile.importer, specifier, readFile) === null
			) {
				throw new PageShimPortProfileError(
					`cannot resolve module ${JSON.stringify(specifier)} from ${profile.importer} in PageShim port profile ${path}`,
				);
			}
		} else if (!BUILTINS.has(bare)) {
			throw new PageShimPortProfileError(
				`unsupported non-builtin port module ${JSON.stringify(specifier)} in PageShim port profile ${path}`,
			);
		}
	}

	const seenInject = new Set();
	for (const injectPath of profile.inject) {
		validateRepoPath(injectPath, "inject path", path);
		if (seenInject.has(injectPath)) {
			throw new PageShimPortProfileError(
				`duplicate inject path ${injectPath} in PageShim port profile ${path}`,
			);
		}
		seenInject.add(injectPath);
		readRequired(readFile, injectPath, "cannot read PageShim port inject file");
	}

	return { ...profile, modules: [...seenModules], path, empty: false };
}
