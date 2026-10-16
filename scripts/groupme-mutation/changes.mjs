// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Git boundary for the GroupMe mutation runner. It validates commits, reads NUL-delimited
// name-status metadata, fetches each relevant file's zero-context diff by argv pathspec
// (never a shell string), and hands the records to the pure selector.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { selectMutationRanges } from "./select.mjs";

const execFileAsync = promisify(execFile);
const fullSha = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const groupmePrefix = "connectors/groupme/";
const statusLetters = /^(?:A|M|T|D|R\d{1,3}|C\d{1,3})$/;

export async function git(repo, args) {
	const { stdout } = await execFileAsync(
		"git",
		["--literal-pathspecs", ...args],
		{ cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
	return stdout;
}

function parseNameStatus(raw) {
	const fields = raw.split("\0");
	if (fields.pop() !== "") throw new Error("malformed NUL name-status output");
	const records = [];
	for (let i = 0; i < fields.length; ) {
		const status = fields[i++];
		if (!statusLetters.test(status))
			throw new Error("unknown name-status " + status);
		const count = status[0] === "R" || status[0] === "C" ? 2 : 1;
		const paths = fields.slice(i, i + count);
		if (paths.length !== count || paths.some((entry) => !entry))
			throw new Error("malformed NUL name-status path list");
		i += count;
		records.push(
			count === 2
				? { status: status[0], path: paths[1], oldPath: paths[0] }
				: { status: status[0], path: paths[0] },
		);
	}
	return records;
}

// Validates the range inputs against the repository and HEAD before anything is mutated.
export async function validateRange(repo, { base, head, mergeBase }) {
	for (const [label, value] of [
		["base", base],
		["head", head],
		["merge-base", mergeBase],
	]) {
		if (typeof value !== "string" || !fullSha.test(value))
			throw new Error(`${label} must be a full lowercase commit SHA`);
		await git(repo, ["cat-file", "-e", `${value}^{commit}`]);
	}
	const computed = (await git(repo, ["merge-base", base, head])).trim();
	if (computed !== mergeBase)
		throw new Error(
			"merge-base does not equal git merge-base of base and head",
		);
	if ((await git(repo, ["rev-parse", "--verify", "HEAD"])).trim() !== head)
		throw new Error(
			"HEAD must equal --head so mutated ranges name checked-out lines",
		);
	if (
		(await git(repo, ["status", "--porcelain", "--untracked-files=no"])).trim()
	)
		throw new Error(
			"tracked working tree changes would detach ranges from HEAD",
		);
}

// Returns the selector result plus the count of changed files outside GroupMe scope.
export async function selectChanges(repo, range) {
	await validateRange(repo, range);
	const { base, head, mergeBase } = range;
	const records = parseNameStatus(
		await git(repo, [
			"diff",
			"--name-status",
			"-z",
			"--find-renames",
			"--no-ext-diff",
			mergeBase,
			head,
		]),
	);
	const relevant = records.filter(
		(record) =>
			record.path.startsWith(groupmePrefix) ||
			record.oldPath?.startsWith(groupmePrefix),
	);
	const withDiffs = [];
	for (const record of relevant) {
		const pathspec = [
			...new Set([record.oldPath, record.path].filter(Boolean)),
		];
		const diff = await git(repo, [
			"diff",
			"--unified=0",
			"--no-color",
			"--no-ext-diff",
			"--no-textconv",
			"--find-renames",
			mergeBase,
			head,
			"--",
			...pathspec,
		]);
		withDiffs.push({ ...record, diff });
	}
	return {
		base,
		head,
		mergeBase,
		changedFiles: records.length,
		outOfScopeFiles: records.length - relevant.length,
		selection: selectMutationRanges(withDiffs),
	};
}
