// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const helpText = "Developer Tools → Cookies: café, 東京, 🐟";
const diagnostic = "Formatter failed → 東京";

function fixture(t, fail = false) {
	const root = mkdtempSync(join(tmpdir(), "implementation-index-utf8-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const directory of ["scripts", "connectors/example", "node_modules/.bin"]) {
		mkdirSync(join(root, directory), { recursive: true });
	}
	writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
	copyFileSync(new URL("./generate-connector-implementation-index.mjs", import.meta.url), join(root, "scripts/generate-connector-implementation-index.mjs"));
	writeFileSync(join(root, "connectors/example/index.ts"), "export {};\n");
	writeFileSync(join(root, "connectors/example/manifest.json"), JSON.stringify({
		connector_id: "https://registry.pdpp.dev/connectors/example",
		version: "0.1.0",
		help_text: helpText,
	}));
	// Separate writes split the arrow's UTF-8 bytes across stdout/stderr chunks.
	writeFileSync(join(root, "node_modules/.bin/biome"), `#!/usr/bin/env node
let source = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { source += chunk; });
process.stdin.on("end", () => {
  const bytes = Buffer.from(${fail ? JSON.stringify(diagnostic) : "source"});
  const boundary = bytes.indexOf(Buffer.from("→")) + 1;
  const output = process.${fail ? "stderr" : "stdout"};
  output.write(bytes.subarray(0, boundary));
  setTimeout(() => { output.end(bytes.subarray(boundary)); process.exitCode = ${fail ? 1 : 0}; }, 30);
});
`, { mode: 0o755 });
	return root;
}

function generate(root, ...args) {
	return spawnSync(process.execPath, [join(root, "scripts/generate-connector-implementation-index.mjs"), ...args], {
		cwd: root,
		encoding: "utf8",
		timeout: 10_000,
	});
}

test("index generation preserves manifest text when formatter chunks split UTF-8", (t) => {
	const root = fixture(t);
	const result = generate(root);
	assert.equal(result.status, 0, result.stderr);
	const index = JSON.parse(readFileSync(join(root, "connector-implementation-index.json"), "utf8"));
	assert.equal(index.connectors[0].manifest.help_text, helpText);
	const checked = generate(root, "--check");
	assert.equal(checked.status, 0, checked.stderr);
});

test("index generation preserves formatter diagnostics when stderr chunks split UTF-8", (t) => {
	const result = generate(fixture(t, true));
	assert.notEqual(result.status, 0);
	assert.ok(result.stderr.includes(diagnostic), result.stderr);
});
