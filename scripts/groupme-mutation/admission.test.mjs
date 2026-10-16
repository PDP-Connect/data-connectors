// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const admissionPath = resolve(
	fileURLToPath(
		new URL(
			"../../.github/scripts/groupme-mutation-admission.mjs",
			import.meta.url,
		),
	),
);
const workflowPath = resolve(
	fileURLToPath(
		new URL("../../.github/workflows/polyfill-connectors.yml", import.meta.url),
	),
);
const index = "connectors/groupme/index.ts";
const schemas = "connectors/groupme/schemas.ts";

function git(repo, ...args) {
	return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

async function fixture(t, files = { README: "base\n" }) {
	await mkdir(join(homedir(), ".tmp"), { recursive: true });
	const repo = await mkdtemp(join(homedir(), ".tmp", "groupme-admission-"));
	t.after(() => rm(repo, { recursive: true, force: true }));
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "fixture@example.invalid");
	git(repo, "config", "user.name", "Fixture");
	for (const [name, contents] of Object.entries(files)) {
		await mkdir(dirname(join(repo, name)), { recursive: true });
		await writeFile(join(repo, name), contents);
	}
	git(repo, "add", "--all");
	git(repo, "commit", "-qm", "base");
	return { repo, base: git(repo, "rev-parse", "HEAD") };
}

function admit(repo, env) {
	const result = spawnSync(process.execPath, [admissionPath], {
		cwd: repo,
		encoding: "utf8",
		env: { ...process.env, EVENT_NAME: "push", GITHUB_WORKSPACE: repo, ...env },
	});
	return {
		result,
		output: result.stdout ? JSON.parse(result.stdout) : null,
	};
}

async function commitChange(
	t,
	name,
	contents,
	{ remove = false, rename } = {},
) {
	const { repo, base } = await fixture(t, {
		[name]: "registered\n",
		README: "base\n",
	});
	if (rename) git(repo, "mv", name, rename);
	else if (remove) git(repo, "rm", "-q", name);
	else {
		await mkdir(dirname(join(repo, name)), { recursive: true });
		await writeFile(join(repo, name), contents);
	}
	git(repo, "add", "--all");
	git(repo, "commit", "-qm", "change");
	return { repo, base, head: git(repo, "rev-parse", "HEAD") };
}

test("CI admission uses the full push range, both rename paths, and fails closed without before", async (t) => {
	const fx = await fixture(t, { README: "base\n" });
	await mkdir(join(fx.repo, "scripts/groupme-mutation"), { recursive: true });
	await writeFile(
		join(fx.repo, "scripts/groupme-mutation/run.ts"),
		"// harness\n",
	);
	git(fx.repo, "add", "--all");
	git(fx.repo, "commit", "-qm", "commit A: harness change");
	await writeFile(join(fx.repo, "README"), "base plus docs\n");
	git(fx.repo, "add", "--all");
	git(fx.repo, "commit", "-qm", "commit B: docs only");
	const head = git(fx.repo, "rev-parse", "HEAD");
	assert.equal(
		admit(fx.repo, { BEFORE_SHA: fx.base, HEAD_SHA: head }).output
			.mutationRequired,
		true,
	);
	assert.notEqual(
		admit(fx.repo, { BEFORE_SHA: undefined, HEAD_SHA: head }).result.status,
		0,
	);

	for (const change of [
		{ rename: "connectors/groupme/moved.ts" },
		{ remove: true },
	]) {
		const moved = await commitChange(t, index, undefined, change);
		const admitted = admit(moved.repo, {
			BEFORE_SHA: moved.base,
			HEAD_SHA: moved.head,
		});
		assert.equal(
			admitted.output.mutationRequired,
			true,
			JSON.stringify(change),
		);
	}
});

test("helper, config and isolated-lock changes admit ordinary verification; docs-only does not", async (t) => {
	for (const name of [
		"scripts/groupme-mutation/tools/package-lock.json",
		"scripts/groupme-mutation/vitest.config.mjs",
		".github/scripts/groupme-mutation-admission.mjs",
		"package.json",
	]) {
		const change = await commitChange(t, name, "changed\n");
		const { output } = admit(change.repo, {
			BEFORE_SHA: change.base,
			HEAD_SHA: change.head,
		});
		assert.equal(output.harness, true, name);
		assert.equal(output.relevant, true, name);
		assert.equal(output.mutationRequired, true, name);
	}
	const docs = await commitChange(t, "docs/notes.md", "changed\n");
	const { output } = admit(docs.repo, {
		BEFORE_SHA: docs.base,
		HEAD_SHA: docs.head,
	});
	assert.equal(output.relevant, false);
	assert.equal(output.mutationRequired, false);
});

test("both supported GroupMe production files admit the mutation run; other GroupMe files do not", async (t) => {
	for (const name of [index, schemas]) {
		const change = await commitChange(t, name, "changed\n");
		const { output } = admit(change.repo, {
			BEFORE_SHA: change.base,
			HEAD_SHA: change.head,
		});
		assert.equal(output.groupme, true, name);
		assert.equal(output.mutationRequired, true, name);
	}
	const other = await commitChange(
		t,
		"connectors/groupme/collection.ts",
		"changed\n",
	);
	const { output } = admit(other.repo, {
		BEFORE_SHA: other.base,
		HEAD_SHA: other.head,
	});
	assert.equal(output.groupme, false);
	assert.equal(output.mutationRequired, false);
});

test("optional evidence is visible but never blocks; required evidence must succeed when admitted", () => {
	const gate = (env) =>
		spawnSync(process.execPath, [admissionPath, "--gate"], {
			encoding: "utf8",
			env: { ...process.env, ...env },
		});
	// Default enforcement is optional: a failed evidence job is reported, not blocking.
	const optional = gate({
		MUTATION_REQUIRED: "true",
		MUTATION_RESULT: "failure",
	});
	assert.equal(optional.status, 0, optional.stderr);
	assert.match(optional.stdout, /not a required check yet/);
	assert.equal(
		gate({
			MUTATION_ENFORCEMENT: "optional",
			MUTATION_REQUIRED: "true",
			MUTATION_RESULT: "failure",
		}).status,
		0,
	);

	const required = (requiredFlag, result) =>
		gate({
			MUTATION_ENFORCEMENT: "required",
			MUTATION_REQUIRED: requiredFlag,
			MUTATION_RESULT: result,
		});
	assert.equal(required("true", "success").status, 0);
	assert.notEqual(required("true", "skipped").status, 0);
	assert.notEqual(required("true", "failure").status, 0);
	assert.equal(required("false", "skipped").status, 0);
	assert.notEqual(required("false", "failure").status, 0);
	assert.notEqual(
		gate({ MUTATION_ENFORCEMENT: "sometimes", MUTATION_RESULT: "success" })
			.status,
		0,
	);
});

test("the workflow keeps GroupMe evidence visible but non-required and free of hidden failures", () => {
	const workflow = readFileSync(workflowPath, "utf8");
	const job = workflow.slice(
		workflow.indexOf("  groupme-mutation:\n"),
		workflow.indexOf("  gate:\n"),
	);
	assert.match(job, /timeout-minutes: 20/);
	assert.doesNotMatch(job, /continue-on-error|\|\| true/);
	assert.doesNotMatch(job, /--mode qualify|tools\/groupme-mutation-pilot/);
	assert.match(job, /ref: \$\{\{ needs\.changes\.outputs\.head_sha \}\}/);
	const install = job.indexOf("npm ci --prefix scripts/groupme-mutation/tools");
	const run = job.indexOf("npm run groupme-mutation -- --mode diff");
	assert.ok(
		install > 0 && install < run,
		"tools install must precede the runner",
	);
	const gate = workflow.slice(workflow.indexOf("  gate:\n"));
	assert.match(gate, /MUTATION_ENFORCEMENT: optional/);
	assert.doesNotMatch(gate, /MUTATION_ENFORCEMENT: required/);
});
