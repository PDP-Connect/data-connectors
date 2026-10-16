// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Pure API: selectMutationRanges([{path,status,diff,oldPath?}]).
// status is A/M/D/R/C; path is HEAD path (deleted path for D); R/C require oldPath.
// diff is one complete --unified=0 file diff. No Git/IO/execution occurs here.
const supported = new Set([
	"connectors/groupme/index.ts",
	"connectors/groupme/schemas.ts",
]);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function fail(reason) {
	throw new Error("Invalid mutation selection input: " + reason);
}
function safePath(path) {
	if (
		typeof path !== "string" ||
		!path ||
		path.trim() !== path ||
		/\p{Cc}|[\\:*?[\]{}!]/u.test(path) ||
		path.startsWith("/") ||
		path.split("/").some((part) => !part || part === "." || part === "..")
	)
		fail("unsafe path");
	return path;
}
function production(path) {
	return (
		path.startsWith("connectors/groupme/") &&
		path.endsWith(".ts") &&
		!path.endsWith(".test.ts") &&
		!path.endsWith(".d.ts") &&
		!/(?:^|\/)(?:__fixtures__|fixtures|tests|docs)(?:\/|$)/.test(path)
	);
}
function position(start, count) {
	const a = Number(start),
		n = Number(count ?? "1");
	if (
		!Number.isSafeInteger(a) ||
		!Number.isSafeInteger(n) ||
		a < 0 ||
		n < 0 ||
		(n > 0 && a === 0) ||
		!Number.isSafeInteger(a + Math.max(n - 1, 0))
	)
		fail("invalid or overflowing hunk position");
	return [a, n];
}
function parseHunks(diff, status) {
	if (typeof diff !== "string" || diff.includes("\r") || diff.includes("\0"))
		fail("diff must be LF text");
	const ranges = [];
	let hunk = null,
		removed = 0,
		added = 0,
		sawHunk = false;
	function finish() {
		if (!hunk) return;
		if (removed !== hunk.oldCount || added !== hunk.newCount)
			fail("truncated or inconsistent zero-context hunk");
		hunk = null;
	}
	const lines = diff.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith("@@")) {
			finish();
			const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(
				line,
			);
			if (!match) fail("malformed hunk header");
			const [, oldCount] = position(match[1], match[2]);
			const [start, newCount] = position(match[3], match[4]);
			if (
				(!oldCount && !newCount) ||
				(status === "A" && oldCount) ||
				(status === "D" && newCount)
			)
				fail("status contradicts hunk");
			hunk = { oldCount, newCount };
			removed = 0;
			added = 0;
			sawHunk = true;
			if (newCount) ranges.push([start, start + newCount - 1]);
		} else if (line === "\\ No newline at end of file") {
			if (!hunk || removed + added === 0) fail("misplaced newline marker");
		} else if (hunk && (removed < hunk.oldCount || added < hunk.newCount)) {
			if (line.startsWith("-")) removed++;
			else if (line.startsWith("+")) added++;
			else fail("context or truncated hunk body");
			if (removed > hunk.oldCount || added > hunk.newCount)
				fail("hunk count mismatch");
		} else {
			finish();
			if (line === "" && i === lines.length - 1) continue;
			if (
				/^(?:diff --git |index |--- |\+\+\+ |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to )/.test(
					line,
				)
			) {
				if (sawHunk) fail("multiple file diffs in one record");
				continue;
			}
			fail("unexpected diff line");
		}
	}
	finish();
	return ranges;
}
function coalesce(ranges) {
	const merged = [];
	for (const [start, end] of ranges.sort(
		(a, b) => a[0] - b[0] || a[1] - b[1],
	)) {
		const last = merged.at(-1);
		if (last && (start <= last[1] || start - last[1] === 1))
			last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	return merged;
}
export function selectMutationRanges(records) {
	if (!Array.isArray(records)) fail("records must be an array");
	const seen = new Set(),
		removedPaths = new Set(),
		files = [];
	for (const record of records) {
		if (
			!record ||
			typeof record !== "object" ||
			Array.isArray(record) ||
			Object.keys(record).some(
				(key) => !["path", "status", "diff", "oldPath"].includes(key),
			)
		)
			fail("invalid record metadata");
		const { status, diff } = record,
			path = safePath(record.path);
		if (!["A", "M", "D", "R", "C"].includes(status)) fail("unknown status");
		if (seen.has(path)) fail("duplicate HEAD path");
		seen.add(path);
		const moved = status === "R" || status === "C";
		if (moved !== Object.hasOwn(record, "oldPath"))
			fail("oldPath required only for rename/copy");
		const oldPath = moved ? safePath(record.oldPath) : path;
		if (moved && oldPath === path) fail("rename/copy paths must differ");
		if (status === "R") {
			if (removedPaths.has(oldPath)) fail("duplicate rename source");
			removedPaths.add(oldPath);
		}
		const ranges = coalesce(parseHunks(diff, status));
		const unsupportedPaths = [...new Set([oldPath, path])]
			.filter((p) => production(p) && !supported.has(p))
			.sort(compare);
		let disposition;
		if (unsupportedPaths.length) disposition = "unsupported";
		else if (status === "D")
			disposition = supported.has(path) ? "deleted" : "scoped-out";
		else if (!supported.has(path)) disposition = "scoped-out";
		else if (!ranges.length)
			disposition = diff.includes("@@") ? "deletion-only" : "no-applicable";
		else disposition = "selected";
		files.push({
			path,
			status,
			...(moved ? { oldPath } : {}),
			disposition,
			ranges: disposition === "selected" ? ranges : [],
			unsupportedPaths,
		});
	}
	for (const path of removedPaths)
		if (seen.has(path)) fail("rename source also has a record");
	files.sort((a, b) => compare(a.path, b.path));
	const mutate = files.flatMap((file) =>
		file.ranges.map(([start, end]) => file.path + ":" + start + "-" + end),
	);
	return {
		disposition: files.some((f) => f.disposition === "unsupported")
			? "unsupported"
			: mutate.length
				? "selected"
				: "no-applicable",
		mutate,
		files,
	};
}
