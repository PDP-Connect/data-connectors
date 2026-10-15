// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const repo = process.env.GITHUB_WORKSPACE ?? process.cwd();
const event = process.env.EVENT_NAME;
const target = "connectors/groupme/index.ts";
const zeroSha = /^0+$/;

function git(args) {
	return execFileSync("git", args, {
		cwd: repo,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function commitSha(value, label) {
	if (!value || !/^[0-9a-f]{40,64}$/i.test(value) || zeroSha.test(value))
		throw new Error(`${label} must be a nonzero full commit SHA`);
	git(["cat-file", "-e", `${value}^{commit}`]);
	return value;
}

function pathFlags(changed) {
	const allPaths = changed.flatMap(({ paths }) => paths);
	const relevant = allPaths.some(
		(file) =>
			file.startsWith("connectors/") ||
			file.startsWith("packages/polyfill-connectors/") ||
			file === ".github/workflows/polyfill-connectors.yml",
	);
	const harness = allPaths.some(
		(file) =>
			file.startsWith("scripts/groupme-mutation/") ||
			file === ".github/scripts/groupme-mutation-admission.mjs" ||
			file === "package.json" ||
			file === ".github/workflows/polyfill-connectors.yml",
	);
	const groupme = allPaths.includes(target);
	return { relevant, harness, groupme, mutationRequired: harness || groupme };
}

try {
	let result;
	if (process.argv[2] === "--gate") {
		const required = process.env.MUTATION_REQUIRED === "true";
		const mutationResult = process.env.MUTATION_RESULT;
		const accepted = required
			? mutationResult === "success"
			: mutationResult === "success" || mutationResult === "skipped";
		result = { required, mutationResult, accepted };
		process.stdout.write(`${JSON.stringify(result)}\n`);
		if (!accepted)
			throw new Error(
				`mutation gate rejected result '${mutationResult}' (required=${required})`,
			);
	} else if (event !== "push" && event !== "pull_request") {
		result = {
			event,
			before: null,
			base: null,
			head: null,
			mergeBase: null,
			changed: [],
			...pathFlags([]),
		};
	} else {
		const head = commitSha(process.env.HEAD_SHA, "head SHA");
		const before =
			event === "push"
				? commitSha(process.env.BEFORE_SHA, "push before SHA")
				: undefined;
		const base =
			event === "pull_request"
				? commitSha(process.env.BASE_SHA, "pull request base SHA")
				: before;
		const mergeBase = git(["merge-base", base, head]).trim();
		commitSha(mergeBase, "merge-base SHA");
		const raw = git([
			"diff",
			"--name-status",
			"-z",
			"--find-renames",
			mergeBase,
			head,
		]);
		const fields = raw ? raw.split("\0") : [];
		if (fields.length && fields.at(-1) !== "")
			throw new Error("malformed NUL name-status terminator");
		if (fields.length) fields.pop();
		const changed = [];
		for (let i = 0; i < fields.length; ) {
			const status = fields[i++];
			if (!status || !/^(?:A|M|T|D|R\d{1,3}|C\d{1,3})$/.test(status))
				throw new Error("malformed NUL name-status diff");
			const count = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
			const paths = fields.slice(i, i + count);
			if (paths.length !== count || paths.some((entry) => !entry))
				throw new Error("malformed NUL name-status path list");
			i += count;
			changed.push({ status, paths });
		}
		result = {
			event,
			before: before ?? null,
			base,
			head,
			mergeBase,
			changed,
			...pathFlags(changed),
		};
	}
	process.stdout.write(`${JSON.stringify(result)}\n`);
	if (process.env.GITHUB_OUTPUT) {
		appendFileSync(
			process.env.GITHUB_OUTPUT,
			`relevant=${result.relevant}\nharness=${result.harness}\ngroupme=${result.groupme}\nmutation_required=${result.mutationRequired}\nbase_sha=${result.base ?? ""}\nhead_sha=${result.head ?? ""}\nmerge_base_sha=${result.mergeBase ?? ""}\n`,
		);
	}
} catch (error) {
	process.stderr.write(
		`${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exitCode = 1;
}
