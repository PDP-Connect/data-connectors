// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const COPY = "packages/polyfill-connectors/src/reason-copy.json";
const RUNTIME_CODES =
	"packages/polyfill-connectors/src/reference-implementation-stand-in/runtime/recovery-reason-codes.ts";

const SHARED = {
	sign_in: "{site} needs you to sign in again.",
	busy: "Wait a while, then run again.",
};

function manifestText(fields, indent = "\t") {
	return `${JSON.stringify(fields, null, indent)}\n`;
}

/**
 * A temp repo with the generator, the real runtime-codes module and the real
 * biome, so the written text is what the repo's formatter produces.
 */
function fixture(t, { copy, manifests, indent = "\t" }) {
	const root = mkdtempSync(join(tmpdir(), "reason-copy-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const directory of [
		"scripts",
		"node_modules/.bin",
		dirname(COPY),
		dirname(RUNTIME_CODES),
	]) {
		mkdirSync(join(root, directory), { recursive: true });
	}
	writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
	copyFileSync(
		join(here, "generate-reason-display-messages.mjs"),
		join(root, "scripts/generate-reason-display-messages.mjs"),
	);
	copyFileSync(join(repoRoot, RUNTIME_CODES), join(root, RUNTIME_CODES));
	symlinkSync(
		join(repoRoot, "node_modules/.bin/biome"),
		join(root, "node_modules/.bin/biome"),
	);
	writeFileSync(join(root, COPY), JSON.stringify(copy));
	for (const [dir, fields] of Object.entries(manifests)) {
		mkdirSync(join(root, "connectors", dir), { recursive: true });
		writeFileSync(
			join(root, "connectors", dir, "manifest.json"),
			manifestText(fields, indent),
		);
	}
	return root;
}

function run(root, ...args) {
	return spawnSync(
		process.execPath,
		[join(root, "scripts/generate-reason-display-messages.mjs"), ...args],
		{ cwd: root, encoding: "utf8", timeout: 20_000 },
	);
}

function readManifest(root, dir) {
	return readFileSync(join(root, "connectors", dir, "manifest.json"), "utf8");
}

const base = {
	connector_key: "example",
	version: "1.0.0",
	display_name: "Example (Live Session)",
	streams: [{ name: "items" }],
};

test("stamps shared and specific copy, sorted by code, with {site} resolved", (t) => {
	const root = fixture(t, {
		copy: {
			shared: SHARED,
			connectors: {
				example: {
					zz_last: "busy",
					aa_first: "sign_in",
					mm_mid: { message: "Only {site} says this." },
				},
			},
		},
		manifests: { example: base },
	});
	const result = run(root);
	assert.equal(result.status, 0, result.stderr);
	const manifest = JSON.parse(readManifest(root, "example"));
	assert.deepEqual(Object.keys(manifest.reason_display_messages), [
		"aa_first",
		"mm_mid",
		"zz_last",
	]);
	assert.deepEqual(manifest.reason_display_messages, {
		aa_first: "Example needs you to sign in again.",
		mm_mid: "Only Example says this.",
		zz_last: "Wait a while, then run again.",
	});
	// Every other field keeps its value and its position; the new member is last.
	assert.deepEqual(Object.keys(manifest), [
		...Object.keys(base),
		"reason_display_messages",
	]);
	assert.deepEqual(
		{ ...manifest, reason_display_messages: undefined },
		{ ...base, reason_display_messages: undefined },
	);
});

test("replaces an existing member in place and leaves every other byte alone", (t) => {
	const root = fixture(t, {
		copy: { shared: SHARED, connectors: { example: { a_code: "busy" } } },
		manifests: {},
	});
	// Hand-formatted text that biome would reflow: it must survive untouched.
	const original = `{
\t"connector_key": "example",
\t"display_name": "Example",
\t"streams": [{ "name": "items", "tags": ["a", "b"] }],
\t"reason_display_messages": {
\t\t"a_code": "old text"
\t},
\t"mobile": { "enabled": true }
}
`;
	mkdirSync(join(root, "connectors/example"), { recursive: true });
	writeFileSync(join(root, "connectors/example/manifest.json"), original);
	assert.equal(run(root).status, 0);
	assert.equal(
		readManifest(root, "example"),
		original.replace("old text", "Wait a while, then run again."),
	);
});

test("keeps a two-space manifest in two spaces", (t) => {
	const root = fixture(t, {
		copy: { shared: SHARED, connectors: { example: { a_code: "busy" } } },
		manifests: { example: base },
		indent: "  ",
	});
	assert.equal(run(root).status, 0);
	const text = readManifest(root, "example");
	assert.match(text, /\n {2}"reason_display_messages": \{\n {4}"a_code": /);
	assert.doesNotMatch(text, /\t/);
});

test("a second run changes nothing and --check passes", (t) => {
	const root = fixture(t, {
		copy: { shared: SHARED, connectors: { example: { a_code: "busy" } } },
		manifests: { example: base },
	});
	assert.equal(run(root).status, 0);
	const first = readManifest(root, "example");
	assert.equal(run(root).status, 0);
	assert.equal(readManifest(root, "example"), first);
	const checked = run(root, "--check");
	assert.equal(checked.status, 0, checked.stderr);
});

test("--check lists stale manifests, exits 1 and writes nothing", (t) => {
	const root = fixture(t, {
		copy: { shared: SHARED, connectors: { example: { a_code: "busy" } } },
		manifests: {
			example: base,
			other: { connector_key: "other", version: "1.0.0" },
		},
	});
	const before = readManifest(root, "example");
	const result = run(root, "--check");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /connectors\/example\/manifest\.json/);
	assert.doesNotMatch(result.stderr, /connectors\/other\//);
	assert.equal(readManifest(root, "example"), before);
});

test("--check fails when a manifest drifts from the copy file", (t) => {
	const root = fixture(t, {
		copy: { shared: SHARED, connectors: { example: { a_code: "busy" } } },
		manifests: { example: base },
	});
	assert.equal(run(root).status, 0);
	const stamped = JSON.parse(readManifest(root, "example"));
	stamped.reason_display_messages.a_code = "edited by hand";
	writeFileSync(
		join(root, "connectors/example/manifest.json"),
		manifestText(stamped),
	);
	const result = run(root, "--check");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /connectors\/example\/manifest\.json/);
});

const invalid = [
	[
		"an unknown shared key",
		{ shared: SHARED, connectors: { example: { a_code: "nope" } } },
		base,
		/example\.a_code: unknown shared key "nope"/,
	],
	[
		"a connector with no manifest",
		{ shared: SHARED, connectors: { ghost: { a_code: "busy" } } },
		base,
		/ghost: .*no connectors\/\*\/manifest\.json/,
	],
	[
		"a runtime-generic code",
		{ shared: SHARED, connectors: { example: { rate_limited: "busy" } } },
		base,
		/example\.rate_limited: the runtime owns this code/,
	],
	[
		"an empty message",
		{ shared: SHARED, connectors: { example: { a_code: { message: "  " } } } },
		base,
		/example\.a_code: message is empty/,
	],
	[
		"an empty shared message",
		{ shared: { quiet: "" }, connectors: { example: { a_code: "quiet" } } },
		base,
		/example\.a_code: message is empty/,
	],
	[
		"an unresolved placeholder",
		{
			shared: SHARED,
			connectors: { example: { a_code: { message: "Try {thing} again." } } },
		},
		base,
		/example\.a_code: unresolved placeholder \{thing\}/,
	],
	[
		"{site} with no display_name",
		{ shared: SHARED, connectors: { example: { a_code: "sign_in" } } },
		{ connector_key: "example", version: "1.0.0" },
		/example\.a_code: message uses \{site\} but .* no display_name/,
	],
	[
		"a code the manifest declares today but the copy file drops",
		{ shared: SHARED, connectors: { example: { a_code: "busy" } } },
		{ ...base, reason_display_messages: { a_code: "x", dropped_code: "y" } },
		/example\.dropped_code: .*declares this code but reason-copy\.json does not/,
	],
	[
		"a manifest with declared codes and no entry in the copy file",
		{ shared: SHARED, connectors: {} },
		{ ...base, reason_display_messages: { a_code: "x" } },
		/example\.a_code: .*declares this code/,
	],
];

for (const [name, copy, manifest, pattern] of invalid) {
	test(`fails and writes nothing for ${name}`, (t) => {
		const root = fixture(t, { copy, manifests: { example: manifest } });
		const before = readManifest(root, "example");
		for (const args of [[], ["--check"]]) {
			const result = run(root, ...args);
			assert.equal(result.status, 1, result.stdout);
			assert.match(result.stderr, pattern);
		}
		assert.equal(readManifest(root, "example"), before);
	});
}

test("reports every problem in one run", (t) => {
	const root = fixture(t, {
		copy: {
			shared: SHARED,
			connectors: { example: { first: "nope", second: "alsonope" } },
		},
		manifests: { example: base },
	});
	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /example\.first: unknown shared key/);
	assert.match(result.stderr, /example\.second: unknown shared key/);
});
