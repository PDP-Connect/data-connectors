// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A filesystem connector's manifest-declared input, resolved for replay.
 *
 * WHY. Upload-style connectors (`setup.modality: "manual_or_upload"`) read an
 * archive the owner already holds — a Strava account export, an Apple Health
 * export — from a directory named by an environment variable. Replay runs the
 * connector inside a default-deny sandbox that does not bind that directory, so
 * a scenario that recorded fine could never replay: the connector reported its
 * input missing even though the path existed on the host.
 *
 * WHERE THE GRANT COMES FROM. The variable's NAME is author-declared data,
 * already required by the personal server for the upload flow:
 * `setup.manual_or_upload.import_dir_env_var`. Its VALUE — where the archive
 * actually lives — comes from whoever runs the tool. That split (the author
 * declares which input, the operator supplies where) is the pattern Bazel
 * (`srcs` vs mount flags), Flatpak (`finish-args` vs `flatpak override`) and Nix
 * (`__noChroot` vs `sandbox-paths`) share; binding an arbitrary caller-named
 * env var would be the one shape none of them use. See
 * ai/research/testing/sandboxed-executors-put-the-path-grant-in-author-
 * declared-manifest-data-and-disclose-widening-as-a-fact-rather-than-
 * blocking-it.md.
 *
 * WHAT THIS DOES NOT COVER. Local-device connectors (claude_code, codex,
 * imessage, ...) read live machine state at hardcoded defaults and declare no
 * import directory; they are out of scope here. Their input also changes run to
 * run, so binding it would not give a stable oracle anyway.
 *
 * PRESENCE GUARD (non-vacuity). Recorded-http requires >=1 recorded
 * interaction and recorded-browser >0 HAR entries so a capture that saw
 * nothing cannot pass. A file input needs the same: an empty or wrong
 * directory would otherwise replay to a vacuous PASS or a confusing mismatch.
 * The guard requires at least one non-empty regular file whose extension the
 * manifest's own `accepted_file_extensions` names. It proves the input is
 * SUBSTANTIVE, not that it is the SAME input the capture used — that needs a
 * content digest, which is deliberately not built here.
 */

import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

/** What the manifest says about where a connector reads its input. */
export interface DeclaredFilesystemInput {
	/** Extensions (with leading dot, lowercased) that count as real input.
	 *  Empty when the manifest names none — then any non-empty file counts. */
	readonly acceptedFileExtensions: readonly string[];
	/** `setup.manual_or_upload.import_dir_env_var`, e.g. `STRAVA_EXPORT_DIR`. */
	readonly envVar: string;
}

/** A declared input that passed the presence guard. */
export interface ResolvedFilesystemInput {
	/** Non-empty regular files matching an accepted extension. */
	readonly acceptedFileCount: number;
	readonly envVar: string;
	/** The directory's real path — what gets bound, and what the child sees. */
	readonly path: string;
}

/**
 * A declared input failed the presence guard. A diagnosed pre-flight verdict
 * naming exactly what is wrong, printed plainly (no stack) by the CLIs.
 */
export class FilesystemInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FilesystemInputError";
	}
}

/** Bounds the walk so a mis-pointed variable (e.g. `$HOME`) cannot stall
 *  replay. Generous for any real export: a Strava archive is one index CSV
 *  plus one file per activity. Hitting it with zero matches still fails. */
const MAX_WALK_ENTRIES = 50_000;
const MAX_WALK_DEPTH = 8;

/**
 * Reads the declared input from a parsed manifest. `undefined` when the
 * connector declares none — the caller then changes nothing.
 */
export function readDeclaredFilesystemInput(
	manifest: unknown,
): DeclaredFilesystemInput | undefined {
	if (!manifest || typeof manifest !== "object") {
		return;
	}
	const setup = (manifest as { setup?: unknown }).setup;
	if (!setup || typeof setup !== "object") {
		return;
	}
	const upload = (setup as { manual_or_upload?: unknown }).manual_or_upload;
	if (!upload || typeof upload !== "object") {
		return;
	}
	const { import_dir_env_var: envVar, accepted_file_extensions: exts } =
		upload as {
			accepted_file_extensions?: unknown;
			import_dir_env_var?: unknown;
		};
	if (typeof envVar !== "string" || envVar.trim() === "") {
		return;
	}
	const acceptedFileExtensions = Array.isArray(exts)
		? exts
				.filter((e): e is string => typeof e === "string" && e.length > 0)
				.map((e) => (e.startsWith(".") ? e : `.${e}`).toLowerCase())
		: [];
	return { envVar: envVar.trim(), acceptedFileExtensions };
}

function isAcceptedFile(name: string, accepted: readonly string[]): boolean {
	if (accepted.length === 0) {
		return true;
	}
	const lower = name.toLowerCase();
	return accepted.some((ext) => lower.endsWith(ext));
}

/**
 * Counts non-empty regular files under `root` whose name has an accepted
 * extension. Symlinks are NOT followed: only `root` itself is bound into the
 * sandbox, so a link pointing elsewhere would be unreadable at replay and must
 * not count as present input.
 */
function countAcceptedFiles(
	root: string,
	accepted: readonly string[],
): { count: number; truncated: boolean } {
	let count = 0;
	let seen = 0;
	const stack: Array<{ depth: number; dir: string }> = [
		{ dir: root, depth: 0 },
	];
	while (stack.length > 0) {
		const next = stack.pop();
		if (next === undefined) {
			break;
		}
		let names: string[];
		try {
			names = readdirSync(next.dir);
		} catch {
			continue;
		}
		for (const name of names) {
			seen += 1;
			if (seen > MAX_WALK_ENTRIES) {
				return { count, truncated: true };
			}
			const full = join(next.dir, name);
			let info: ReturnType<typeof lstatSync>;
			try {
				info = lstatSync(full);
			} catch {
				continue;
			}
			if (info.isDirectory()) {
				if (next.depth < MAX_WALK_DEPTH) {
					stack.push({ dir: full, depth: next.depth + 1 });
				}
			} else if (
				info.isFile() &&
				info.size > 0 &&
				isAcceptedFile(name, accepted)
			) {
				count += 1;
			}
		}
	}
	return { count, truncated: false };
}

function describeAccepted(accepted: readonly string[]): string {
	return accepted.length > 0
		? `a non-empty ${accepted.join(" or ")} file`
		: "a non-empty file";
}

/**
 * Applies the presence guard to a declared input, reading the value from
 * `env`. Throws `FilesystemInputError` with a plain, actionable message when
 * the variable is unset, points nowhere, points at a non-directory, or holds
 * no substantive input.
 */
export function resolveFilesystemInput(
	connector: string,
	declared: DeclaredFilesystemInput,
	env: NodeJS.ProcessEnv,
): ResolvedFilesystemInput {
	const { envVar, acceptedFileExtensions } = declared;
	const raw = env[envVar]?.trim();
	if (!raw) {
		throw new FilesystemInputError(
			`${connector} reads its input from ${envVar} (manifest setup.manual_or_upload.import_dir_env_var), ` +
				`but ${envVar} is not set. Point it at the directory the scenario was recorded from.`,
		);
	}
	let path: string;
	try {
		path = realpathSync(raw);
	} catch {
		throw new FilesystemInputError(
			`${envVar}=${raw} does not exist. Point it at the directory the scenario was recorded from.`,
		);
	}
	if (!statSync(path).isDirectory()) {
		throw new FilesystemInputError(
			`${envVar}=${raw} is not a directory. ${connector} reads a directory of exported files.`,
		);
	}
	const { count, truncated } = countAcceptedFiles(path, acceptedFileExtensions);
	if (count === 0) {
		const suffix = truncated
			? ` (stopped after ${String(MAX_WALK_ENTRIES)} entries — is ${envVar} pointed at the right directory?)`
			: "";
		throw new FilesystemInputError(
			`${envVar}=${raw} contains no input: expected ${describeAccepted(acceptedFileExtensions)}` +
				`${suffix}. A replay against an empty or wrong directory would prove nothing.`,
		);
	}
	return { envVar, path, acceptedFileCount: count };
}
