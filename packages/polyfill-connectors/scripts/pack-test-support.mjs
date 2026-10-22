// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

// Proxy and CA settings for a runner behind a proxy or corporate CA. Each name
// passes through by exact name; never add a credential or NODE_OPTIONS here.
const NETWORK_AND_TRUST_NAMES = [
	// Proxy routing, for networks that reach the registry only through a proxy.
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	// Extra CA bundles, so TLS to the registry trusts a corporate root.
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	// npm's own proxy, CA, TLS and registry settings, in both spellings npm reads.
	"npm_config_proxy",
	"npm_config_https_proxy",
	"npm_config_noproxy",
	"npm_config_cafile",
	"npm_config_ca",
	"npm_config_strict_ssl",
	"npm_config_registry",
	"NPM_CONFIG_PROXY",
	"NPM_CONFIG_HTTPS_PROXY",
	"NPM_CONFIG_NOPROXY",
	"NPM_CONFIG_CAFILE",
	"NPM_CONFIG_CA",
	"NPM_CONFIG_STRICT_SSL",
	"NPM_CONFIG_REGISTRY",
];

// Deliberately omit arbitrary application secrets, NODE_OPTIONS, and npm
// configuration inherited from the invoking shell, except the reviewed network
// and trust group above. Private-registry tests need an explicitly reviewed
// environment contract, not process.env spread.
export function packEnvironment(root, inherited = process.env) {
	const env = {};
	for (const name of [
		"PATH",
		"Path",
		"SystemRoot",
		"SYSTEMROOT",
		"COMSPEC",
		"PATHEXT",
		"LANG",
		"LC_ALL",
		"TZ",
		...NETWORK_AND_TRUST_NAMES,
	]) {
		if (inherited[name] !== undefined) env[name] = inherited[name];
	}
	return {
		...env,
		HOME: path.join(root, "home"),
		USERPROFILE: path.join(root, "home"),
		TMPDIR: path.join(root, "tmp"),
		TMP: path.join(root, "tmp"),
		TEMP: path.join(root, "tmp"),
		npm_config_cache: path.join(root, "npm-cache"),
		// Exercise the real postinstall, including its browser-install path.
		PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "",
		PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "",
	};
}

export async function packPackage(cwd, destination, run) {
	// Exclusive mkdir: never reuse a directory belonging to another run.
	await mkdir(destination);
	await run(
		"npm",
		["pack", "--foreground-scripts=false", "--pack-destination", destination],
		{ cwd },
	);
	const produced = (await readdir(destination)).filter((name) =>
		name.endsWith(".tgz"),
	);
	assert.equal(
		produced.length,
		1,
		`expected exactly one .tgz in ${destination}, found ${produced.length}`,
	);
	return path.join(destination, produced[0]);
}

/**
 * The arguments of the plain install of the packed tarball. The check exists
 * to run the package's install hook, so both flags are explicit: npm 11 and
 * later skip hooks that are not approved, and a global npm config can set
 * ignore-scripts. A command-line flag outranks that config.
 */
export function installArguments(tarball) {
	return [
		"install",
		"--no-audit",
		"--no-fund",
		"--ignore-scripts=false",
		"--dangerously-allow-all-scripts",
		tarball,
	];
}
