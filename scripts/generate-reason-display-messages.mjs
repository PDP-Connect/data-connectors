#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Stamps owner-facing reason copy into every connector manifest.
//
// Source of truth: packages/polyfill-connectors/src/reason-copy.json. It holds a
// small set of shared sentences plus, per connector, which sentence each code
// uses (or a connector-specific sentence). This script resolves that into the
// plain `reason_display_messages` object each manifest keeps, so consumers that
// read manifests (Desktop, the pdpp reference implementation) need no change.
//
// Only the `reason_display_messages` member is rewritten. The rest of each
// manifest stays byte for byte as it was, and the new member is formatted by
// the repo's biome, so a diff shows only the copy lines.
//
//   node scripts/generate-reason-display-messages.mjs           write manifests
//   node scripts/generate-reason-display-messages.mjs --check   list stale manifests, write nothing
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const connectorsDirectory = path.join(repoRoot, "connectors");
const copyPath = path.join(
	repoRoot,
	"packages/polyfill-connectors/src/reason-copy.json",
);
// The runtime owns these codes and writes their copy itself. Imported from the
// TS source (Node 24 strips types), so the list is never duplicated here.
const runtimeCodesPath = path.join(
	repoRoot,
	"packages/polyfill-connectors/src/reference-implementation-stand-in/runtime/recovery-reason-codes.ts",
);
const FIELD = "reason_display_messages";

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(file) {
	return JSON.parse(await readFile(file, "utf8"));
}

async function loadRuntimeCodes() {
	const module = await import(pathToFileURL(runtimeCodesPath).href);
	const codes = module.RUNTIME_GENERIC_REASON_CODES;
	if (!(codes instanceof Set) || codes.size === 0) {
		throw new Error(
			`${path.relative(repoRoot, runtimeCodesPath)} must export a non-empty RUNTIME_GENERIC_REASON_CODES set`,
		);
	}
	return codes;
}

/** Every connector directory that has a manifest, keyed by its connector_key. */
async function loadManifests() {
	const manifests = new Map();
	for (const name of (await readdir(connectorsDirectory)).sort()) {
		const file = path.join(connectorsDirectory, name, "manifest.json");
		if (!existsSync(file)) continue;
		const text = await readFile(file, "utf8");
		const manifest = JSON.parse(text);
		const key =
			typeof manifest.connector_key === "string" && manifest.connector_key
				? manifest.connector_key
				: name;
		if (manifests.has(key)) {
			throw new Error(
				`connector_key "${key}" is used by both connectors/${manifests.get(key).dir} and connectors/${name}`,
			);
		}
		manifests.set(key, { dir: name, file, text, manifest });
	}
	return manifests;
}

/** "Claude (Live Session)" -> "Claude". */
function siteName(displayName) {
	return displayName.replace(/\s*\([^()]*\)\s*$/, "").trim();
}

/**
 * Resolves one connector's entries to {code: sentence}, sorted by code.
 * Returns the sentences and a list of problems; problems never throw so one
 * run reports every mistake.
 */
function resolveConnector(
	key,
	entries,
	shared,
	runtimeCodes,
	manifest,
	problems,
) {
	if (!isPlainObject(entries)) {
		problems.push(
			`${key}: connector entry must be an object of code -> key or {message}`,
		);
		return {};
	}
	const resolved = {};
	for (const code of Object.keys(entries).sort()) {
		const where = `${key}.${code}`;
		if (runtimeCodes.has(code)) {
			problems.push(
				`${where}: the runtime owns this code (RUNTIME_GENERIC_REASON_CODES); remove it from reason-copy.json`,
			);
			continue;
		}
		const entry = entries[code];
		let template;
		if (typeof entry === "string") {
			if (!Object.hasOwn(shared, entry)) {
				problems.push(`${where}: unknown shared key "${entry}"`);
				continue;
			}
			template = shared[entry];
		} else if (isPlainObject(entry) && typeof entry.message === "string") {
			template = entry.message;
		} else {
			problems.push(`${where}: must be a shared key or {"message": "..."}`);
			continue;
		}
		if (template.trim() === "") {
			problems.push(`${where}: message is empty`);
			continue;
		}
		let message = template;
		if (message.includes("{site}")) {
			const displayName = manifest.manifest.display_name;
			if (typeof displayName !== "string" || displayName.trim() === "") {
				problems.push(
					`${where}: message uses {site} but connectors/${manifest.dir}/manifest.json has no display_name`,
				);
				continue;
			}
			message = message.replaceAll("{site}", siteName(displayName));
		}
		const placeholder = message.match(/\{[^{}]*\}/);
		if (placeholder) {
			problems.push(`${where}: unresolved placeholder ${placeholder[0]}`);
			continue;
		}
		resolved[code] = message;
	}
	return resolved;
}

/** Renders the member with biome, indented as a top-level manifest member. */
function formatMember(messages, manifestFile) {
	const source = `${JSON.stringify({ [FIELD]: messages }, null, "\t")}\n`;
	return new Promise((resolve, reject) => {
		const biome = spawn(path.join(repoRoot, "node_modules", ".bin", "biome"), [
			"format",
			"--stdin-file-path",
			manifestFile,
		]);
		biome.stdout.setEncoding("utf8");
		biome.stderr.setEncoding("utf8");
		let output = "";
		let error = "";
		biome.stdout.on("data", (chunk) => {
			output += chunk;
		});
		biome.stderr.on("data", (chunk) => {
			error += chunk;
		});
		biome.on("error", reject);
		biome.on("exit", (code) => {
			if (code !== 0) {
				reject(new Error(`Biome failed to format ${FIELD}: ${error}`));
				return;
			}
			const lines = output.trimEnd().split("\n");
			// Drop the wrapper braces; what is left is the member at depth 1.
			resolve(lines.slice(1, -1).join("\n"));
		});
		biome.stdin.end(source);
	});
}

/** The whitespace one level of nesting uses in this manifest (a tab, or N spaces). */
function indentUnit(text) {
	return /\{\r?\n([ \t]+)\S/.exec(text)?.[1] ?? "\t";
}

/** Biome writes tabs; match the file being edited so its own style is kept. */
function reindent(member, unit) {
	if (unit === "\t") return member;
	return member.replace(/^\t+/gm, (tabs) => unit.repeat(tabs.length));
}

/** Index just past the JSON string that starts at `i`. */
function endOfString(text, i) {
	let j = i + 1;
	while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
	return j + 1;
}

/** Index just past the JSON value that starts at `i`. */
function endOfValue(text, i) {
	if (text[i] === '"') return endOfString(text, i);
	if (text[i] === "{" || text[i] === "[") {
		let depth = 0;
		let j = i;
		while (j < text.length) {
			const ch = text[j];
			if (ch === '"') {
				j = endOfString(text, j);
				continue;
			}
			if (ch === "{" || ch === "[") depth += 1;
			if (ch === "}" || ch === "]") depth -= 1;
			j += 1;
			if (depth === 0) return j;
		}
		throw new Error("unterminated JSON value");
	}
	let j = i;
	while (j < text.length && !/[\s,}\]]/.test(text[j])) j += 1;
	return j;
}

/** The top-level members of a JSON object text, with their source spans. */
function topLevelMembers(text) {
	const members = [];
	let i = text.indexOf("{") + 1;
	for (;;) {
		while (/[\s,]/.test(text[i])) i += 1;
		if (text[i] === "}") return { members, closing: i };
		const start = i;
		const keyEnd = endOfString(text, i);
		const key = JSON.parse(text.slice(start, keyEnd));
		i = keyEnd;
		while (/[\s:]/.test(text[i])) i += 1;
		i = endOfValue(text, i);
		// JSON.parse keeps the last duplicate, but the splice would edit the first.
		if (members.some((m) => m.key === key)) {
			throw new Error(`duplicate top-level member "${key}"`);
		}
		members.push({ key, start, end: i });
	}
}

/** Replaces the member in place, or appends it as the last member. */
function spliceMember(text, member) {
	const { members, closing } = topLevelMembers(text);
	const existing = members.find((m) => m.key === FIELD);
	if (existing) {
		// `member` starts with its depth-1 indent; the key position already has it.
		return (
			text.slice(0, existing.start) +
			member.trimStart() +
			text.slice(existing.end)
		);
	}
	const last = members.at(-1);
	if (!last) throw new Error("manifest has no members");
	return `${text.slice(0, last.end)},\n${member}${text.slice(last.end, closing).trimEnd()}\n${text.slice(closing)}`;
}

async function main() {
	const checkOnly = process.argv.includes("--check");
	const copy = await readJson(copyPath);
	const problems = [];
	if (!isPlainObject(copy.shared) || !isPlainObject(copy.connectors)) {
		throw new Error(
			`${path.relative(repoRoot, copyPath)} must have "shared" and "connectors" objects`,
		);
	}
	const runtimeCodes = await loadRuntimeCodes();
	const manifests = await loadManifests();
	const results = [];

	for (const key of Object.keys(copy.connectors).sort()) {
		const manifest = manifests.get(key);
		if (!manifest) {
			problems.push(
				`${key}: reason-copy.json names a connector with no connectors/*/manifest.json`,
			);
			continue;
		}
		const messages = resolveConnector(
			key,
			copy.connectors[key],
			copy.shared,
			runtimeCodes,
			manifest,
			problems,
		);
		results.push({ key, manifest, messages });
	}

	// No silent drops: a code a manifest declares today must stay in the copy file.
	for (const [key, manifest] of manifests) {
		const existing = manifest.manifest[FIELD];
		if (existing === undefined) continue;
		const declared = isPlainObject(copy.connectors[key])
			? copy.connectors[key]
			: {};
		for (const code of Object.keys(existing)) {
			if (!Object.hasOwn(declared, code)) {
				problems.push(
					`${key}.${code}: connectors/${manifest.dir}/manifest.json declares this code but reason-copy.json does not; add it, or remove it from the manifest on purpose`,
				);
			}
		}
	}

	if (problems.length > 0) {
		process.stderr.write(
			`reason-copy.json is invalid:\n${problems.map((p) => `  ${p}`).join("\n")}\n`,
		);
		process.exitCode = 1;
		return;
	}

	const stale = [];
	for (const { manifest, messages } of results) {
		const member = reindent(
			await formatMember(messages, manifest.file),
			indentUnit(manifest.text),
		);
		let next;
		try {
			next = spliceMember(manifest.text, member);
		} catch (error) {
			throw new Error(
				`${path.relative(repoRoot, manifest.file)}: ${error.message}`,
			);
		}
		if (next === manifest.text) continue;
		stale.push(path.relative(repoRoot, manifest.file));
		if (!checkOnly) await writeFile(manifest.file, next);
	}

	if (checkOnly) {
		if (stale.length > 0) {
			process.stderr.write(
				`reason_display_messages is out of date in:\n${stale.map((f) => `  ${f}`).join("\n")}\nRun npm run reason-copy:generate\n`,
			);
			process.exitCode = 1;
			return;
		}
		process.stdout.write(
			"PASS reason_display_messages matches reason-copy.json.\n",
		);
	} else {
		process.stdout.write(
			`Updated ${stale.length} manifest(s) from reason-copy.json.\n`,
		);
	}
}

main().catch((error) => {
	process.stderr.write(`${error.message}\n`);
	process.exitCode = 1;
});
