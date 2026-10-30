// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { selectChanges } from "./changes.mjs";

const target = "connectors/groupme/index.ts";
const source = [
	"export function ascending(messages) {",
	"\tfor (const m of messages) if (m) return true;",
	"\treturn false;",
	"}",
	"",
].join("\n");

function git(repo, ...args) {
	return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

// Fixtures live under ~/.tmp (disk), never /tmp (RAM-backed).
async function fixture(t, files = {}) {
	const root = join(homedir(), ".tmp", "groupme-mutation-changes-");
	await mkdir(join(homedir(), ".tmp"), { recursive: true });
	const repo = await mkdtemp(root);
	t.after(() => rm(repo, { recursive: true, force: true }));
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "fixture@example.invalid");
	git(repo, "config", "user.name", "Fixture");
	await write(repo, files);
	git(repo, "add", "--all");
	git(repo, "commit", "-qm", "base");
	return { repo, base: git(repo, "rev-parse", "HEAD") };
}

async function write(repo, files) {
	for (const [name, contents] of Object.entries(files)) {
		await mkdir(join(repo, dirname(name)), { recursive: true });
		await writeFile(join(repo, name), contents);
	}
}

// Commits the current index and returns the range the runner would receive.
function commit(repo, base, message) {
	git(repo, "add", "--all");
	git(repo, "commit", "-qm", message);
	const head = git(repo, "rev-parse", "HEAD");
	return { base, head, mergeBase: base };
}

const select = (repo, range) =>
	selectChanges(repo, range).then((r) => r.selection);

test("a changed line in the target is selected at its current HEAD position", async (t) => {
	const { repo, base } = await fixture(t, { [target]: source });
	await write(repo, {
		[target]: source.replace("return false;", "return null;"),
	});
	const change = await selectChanges(repo, commit(repo, base, "later change"));
	assert.equal(change.selection.disposition, "selected");
	assert.deepEqual(change.selection.mutate, [target + ":3-3"]);
	assert.equal(change.outOfScopeFiles, 0);
});

test("an edited rename into the target selects the edited lines; a pure rename selects nothing", async (t) => {
	const pure = await fixture(t, { "moved.ts": source });
	await mkdir(join(pure.repo, "connectors/groupme"), { recursive: true });
	git(pure.repo, "mv", "moved.ts", target);
	const pureRange = commit(pure.repo, pure.base, "pure rename");
	assert.deepEqual(await select(pure.repo, pureRange), {
		disposition: "no-applicable",
		mutate: [],
		files: [
			{
				path: target,
				status: "R",
				oldPath: "moved.ts",
				disposition: "no-applicable",
				ranges: [],
				unsupportedPaths: [],
			},
		],
	});

	const edited = await fixture(t, { "moved.ts": source });
	await mkdir(join(edited.repo, "connectors/groupme"), { recursive: true });
	git(edited.repo, "mv", "moved.ts", target);
	await write(edited.repo, {
		[target]: source.replace("return false;", "return null;"),
	});
	const editedSelection = await select(
		edited.repo,
		commit(edited.repo, edited.base, "edited rename"),
	);
	assert.equal(editedSelection.disposition, "selected");
	assert.deepEqual(editedSelection.mutate, [target + ":3-3"]);
});

test("a supported file renamed outside the target is a deletion, not scoped out", async (t) => {
	const { repo, base } = await fixture(t, { [target]: source });
	await mkdir(join(repo, "connectors/github"), { recursive: true });
	git(repo, "mv", target, "connectors/github/moved.ts");
	const selection = await select(repo, commit(repo, base, "rename out"));
	assert.deepEqual(selection.mutate, []);
	assert.equal(selection.files.length, 1);
	assert.equal(selection.files[0].status, "R");
	assert.equal(selection.files[0].oldPath, target);
	assert.equal(selection.files[0].disposition, "deleted");
});

test("deleting the target is a deletion; deleting an unported GroupMe file is unsupported", async (t) => {
	const { repo, base } = await fixture(t, {
		[target]: source,
		"connectors/groupme/collection.ts": "export {};\n",
	});
	git(repo, "rm", "-q", target);
	const deleted = await select(repo, commit(repo, base, "delete target"));
	assert.equal(deleted.files[0].disposition, "deleted");
	assert.deepEqual(deleted.mutate, []);

	const second = git(repo, "rev-parse", "HEAD");
	git(repo, "rm", "-q", "connectors/groupme/collection.ts");
	const unsupported = await select(
		repo,
		commit(repo, second, "delete unported"),
	);
	assert.equal(unsupported.disposition, "unsupported");
	assert.deepEqual(unsupported.files[0].unsupportedPaths, [
		"connectors/groupme/collection.ts",
	]);
});

test("GroupMe-untouched changes are counted out of scope without a diff", async (t) => {
	const { repo, base } = await fixture(t, {
		[target]: source,
		"docs/a.md": "a\n",
	});
	await write(repo, { "docs/a.md": "b\n", "outside/x.ts": "x\n" });
	const change = await selectChanges(repo, commit(repo, base, "docs only"));
	assert.equal(change.changedFiles, 2);
	assert.equal(change.outOfScopeFiles, 2);
	assert.equal(change.selection.disposition, "no-applicable");
});

test("path names with spaces and @@ are passed as argv and never parsed as shell or hunks", async (t) => {
	const hostile = "connectors/groupme/space and @@ name.ts";
	const { repo, base } = await fixture(t, { [target]: source });
	await write(repo, { [hostile]: "export {};\n" });
	const change = await selectChanges(repo, commit(repo, base, "hostile name"));
	assert.equal(change.selection.disposition, "unsupported");
	assert.deepEqual(change.selection.files[0].unsupportedPaths, [hostile]);
});

test("an invalid, unknown, mismatched or unchecked-out range is refused before selection", async (t) => {
	const { repo, base } = await fixture(t, { [target]: source });
	await write(repo, {
		[target]: source.replace("return false;", "return null;"),
	});
	const range = commit(repo, base, "change");
	await assert.rejects(
		selectChanges(repo, { ...range, base: "HEAD" }),
		/base must be a full lowercase commit SHA/,
	);
	await assert.rejects(
		selectChanges(repo, { ...range, head: "0".repeat(40) }),
		/Command failed|head/,
	);
	await assert.rejects(
		selectChanges(repo, { ...range, mergeBase: range.head }),
		/merge-base does not equal/,
	);
	await assert.rejects(
		selectChanges(repo, { ...range, head: base }),
		/HEAD must equal --head/,
	);
	// HEAD still equals the requested head, so only the uncommitted edit can refuse the run.
	await write(repo, { [target]: source + "// dirty\n" });
	await assert.rejects(
		selectChanges(repo, range),
		/tracked working tree changes/,
	);
});
