// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * One-shot source isolation for a single domain mutation attempt (design.md
 * Decision #7). NOT A SANDBOX: this isolates writable state and constrains
 * environment for TRUSTED repository code under a fixed, reviewed operator
 * set. It does not claim filesystem, network, process, CPU, memory, or
 * containment guarantees against hostile code, and it does not claim to
 * recover automatically after verifier death — see workspace.test.ts's
 * credential-sentinel test and design.md's resource-contract table.
 *
 * Workspace root: policy-declared and disk-backed, defaulting to
 * `~/.tmp/mutation-falsification/` — NEVER `/tmp` (RAM-backed tmpfs at 50%
 * of RAM on this host; a debug-build-sized dependency tree there could
 * exhaust host RAM, per this repo's own operating rules). `~/.tmp` sits on
 * the same real disk as the rest of the checkout.
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import { homedir, tmpdir as osTmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorkspacePolicy {
  /** Non-secret environment variable NAMES this workspace's child processes may inherit values for, beyond the isolated paths this file sets itself. */
  environmentAllowlist: string[];
  preparation?: PreparedDependencies;
  /** Minimum free bytes required on the workspace root's filesystem before a clone is attempted. */
  minFreeBytesPreflight: number;
  /** Disk-backed root under which every attempt gets its own subdirectory. Defaults to `~/.tmp/mutation-falsification/`. */
  workspaceRoot: string;
}

export function defaultWorkspaceRoot(): string {
  return join(homedir(), ".tmp", "mutation-falsification");
}

export function defaultWorkspacePolicy(overrides: Partial<WorkspacePolicy> = {}): WorkspacePolicy {
  return {
    workspaceRoot: defaultWorkspaceRoot(),
    // 2 GiB planning floor; no disk-quota or actual dependency-size claim.
    minFreeBytesPreflight: 2 * 1024 * 1024 * 1024,
    environmentAllowlist: [],
    ...overrides,
  };
}

export interface IsolatedWorkspace {
  /** The env object to use for every child process spawned against this workspace. Starts from {} — see buildIsolatedEnvironment. */
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  workspaceDir: string;
}

async function assertFreeSpace(root: string, minFreeBytes: number): Promise<void> {
  await mkdir(root, { recursive: true });
  const info = await statfs(root);
  const freeBytes = info.bavail * info.bsize;
  if (freeBytes < minFreeBytes) {
    throw new Error(
      `createIsolatedWorkspace: free-space preflight failed — ${freeBytes} bytes free under ${root}, need at least ${minFreeBytes}`
    );
  }
}

/** Private writable paths and a fixed non-secret environment; never inherit ambient tool configuration. */
export function buildIsolatedEnvironment(
  workspaceDir: string,
  policy: Pick<WorkspacePolicy, "environmentAllowlist">,
  hostEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const home = resolve(workspaceDir, "home");
  const env: NodeJS.ProcessEnv = {
    HOME: home, TMPDIR: resolve(workspaceDir, "tmp"),
    XDG_CACHE_HOME: resolve(home, ".cache"), XDG_CONFIG_HOME: resolve(home, ".config"),
    XDG_DATA_HOME: resolve(home, ".local/share"), XDG_STATE_HOME: resolve(home, ".local/state"),
    npm_config_cache: resolve(workspaceDir, "npm-cache"),
    npm_config_userconfig: resolve(workspaceDir, "npmrc"),
    npm_config_globalconfig: resolve(workspaceDir, "global-npmrc"),
    PLAYWRIGHT_BROWSERS_PATH: resolve(workspaceDir, "browsers"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, LANG: "C.UTF-8", TZ: "UTC",
  };
  const permitted = new Set(["NODE_ENV", "CI", "TERM"]);
  for (const name of policy.environmentAllowlist) {
    if (!permitted.has(name)) throw new Error(`workspace: forbidden environment name ${name}`);
    if (hostEnv[name] !== undefined) env[name] = hostEnv[name];
  }
  return env;
}

/**
 * Creates a fresh, independent, no-hardlink disk-backed clone of
 * `sourceRepoRoot` at `baseCommitSha`, isolated writable paths, and an
 * isolated environment for any child process run against it. Preflights
 * free disk space first. Does NOT install dependencies — see
 * `materializeDependencies`.
 */
export async function createIsolatedWorkspace(
  policy: WorkspacePolicy,
  sourceRepoRoot: string,
  baseCommitSha: string,
  deadlineAt = Date.now() + 120_000
): Promise<IsolatedWorkspace> {
  await assertFreeSpace(policy.workspaceRoot, policy.minFreeBytesPreflight);
  const workspaceDir = await mkdtemp(resolve(policy.workspaceRoot, "attempt-"));
  const repoRoot = resolve(workspaceDir, "repo");
  const env = buildIsolatedEnvironment(workspaceDir, policy);
  // --no-hardlinks (NOT --local/hardlinked): the clone's object store must
  // never share inodes with the source repo's — a mutant commit or a
  // corrupted object in the clone must never be able to reach back into the
  // source repository's own object store.
  try {
  await execFileAsync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "clone", "--no-hardlinks", "-q", sourceRepoRoot, repoRoot], { env, timeout: remainingTime(deadlineAt) });
  await execFileAsync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-C", repoRoot, "checkout", "-q", baseCommitSha], { env, timeout: remainingTime(deadlineAt) });
  await assertIndependentGitCommonDir(repoRoot, sourceRepoRoot, env);
  } catch (error) {
    await quarantineWorkspace(workspaceDir, `clone/checkout failed: ${String(error)}`);
    throw error;
  }
  for (const dir of ["home", "tmp", "npm-cache", "browsers"]) {
    await mkdir(resolve(workspaceDir, dir), { recursive: true });
  }
  await writeFile(resolve(workspaceDir, "npmrc"), "");
  await writeFile(resolve(workspaceDir, "global-npmrc"), "");
  return { workspaceDir, repoRoot, env };
}

/** Resolves `git rev-parse --git-common-dir` for `repoRoot` as an absolute path. Exported for tests that independently assert clone/source isolation. */
export function gitCommonDirFor(repoRoot: string, env?: NodeJS.ProcessEnv): string {
  const raw = execFileSync("git", ["-C", repoRoot, "rev-parse", "--git-common-dir"], { encoding: "utf8", env: env ?? buildIsolatedEnvironment(resolve(repoRoot,".."), {environmentAllowlist:[]}) }).trim();
  return resolve(repoRoot, raw);
}

/**
 * Verifies the clone's git common directory resolves under the workspace,
 * not the source repository — proves the clone genuinely does not share a
 * Git common directory with the source checkout (a shared common dir would
 * mean the "clone" could corrupt the source repo's own refs/objects).
 */
async function assertIndependentGitCommonDir(workspaceRepoRoot: string, sourceRepoRoot: string, env: NodeJS.ProcessEnv): Promise<void> {
  const commonDir = gitCommonDirFor(workspaceRepoRoot, env);
  const sourceCommonDir = gitCommonDirFor(sourceRepoRoot, env);
  if (!commonDir.startsWith(`${resolve(workspaceRepoRoot)}/`) && commonDir !== resolve(workspaceRepoRoot)) {
    throw new Error(`createIsolatedWorkspace: clone's git common-dir ${commonDir} is not under the workspace`);
  }
  if (commonDir === sourceCommonDir) {
    throw new Error("createIsolatedWorkspace: clone shares a git common-dir with the source repository");
  }
}

export interface PreparedDependencies {
  cacheRoot: string;
  cacheDigest: string;
  browserRoot: string;
  browserDigest: string;
  nativeModule: string;
  nativeDigest: string;
  rootLockDigest: string;
  packageLockDigest: string;
}

export async function fileDigest(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Inventory regular file bytes and modes; reject symlinks rather than following outside retained input. */
export async function directoryDigest(root: string): Promise<string> {
  const entries: Array<[string, number, string]> = [];
  async function visit(dir: string, prefix: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      const path = resolve(dir, name), relative = `${prefix}${name}`;
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`prepared inventory contains symlink: ${relative}`);
      if (info.isDirectory()) await visit(path, `${relative}/`);
      else if (info.isFile()) entries.push([relative, info.mode & 0o777, await fileDigest(path)]);
      else throw new Error(`unsupported prepared file: ${relative}`);
    }
  }
  await visit(root, "");
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function remainingTime(deadlineAt: number, phaseLimit = 120_000): number {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error("groupme batch deadline exceeded before phase");
  return Math.min(remaining, phaseLimit);
}

/** Two offline npm installs, private cache copies, and explicitly retained native/browser prerequisites. */
export async function materializeDependencies(
  workspace: IsolatedWorkspace,
  preparation: PreparedDependencies | undefined,
  deadlineAt: number
): Promise<{ rootLock: string; packageLock: string; cache: string; browser: string; native: string }> {
  if (!preparation) throw new Error("materializeDependencies: verified cache/browser/native preparation is required");
  if (process.version !== "v24.15.0") throw new Error("materializeDependencies: Node 24.15.0 required");
  const packageRoot = resolve(workspace.repoRoot, "packages/polyfill-connectors");
  const rootLock = await fileDigest(resolve(workspace.repoRoot, "package-lock.json"));
  const packageLock = await fileDigest(resolve(packageRoot, "package-lock.json"));
  if (rootLock !== preparation.rootLockDigest || packageLock !== preparation.packageLockDigest) throw new Error("prepared lock identity mismatch");
  const verifyPrepared = async () => {
    if (await directoryDigest(preparation.cacheRoot) !== preparation.cacheDigest ||
        await directoryDigest(preparation.browserRoot) !== preparation.browserDigest ||
        await fileDigest(preparation.nativeModule) !== preparation.nativeDigest) throw new Error("prepared dependency identity mismatch");
  };
  await verifyPrepared();
  await cp(preparation.cacheRoot, workspace.env.npm_config_cache!, { recursive: true, force: false, errorOnExist: false });
  await cp(preparation.browserRoot, workspace.env.PLAYWRIGHT_BROWSERS_PATH!, { recursive: true });
  if (await directoryDigest(workspace.env.npm_config_cache!) !== preparation.cacheDigest ||
      await directoryDigest(workspace.env.PLAYWRIGHT_BROWSERS_PATH!) !== preparation.browserDigest) throw new Error("private preparation copy mismatch");
  const npm = resolve(dirname(process.execPath), "npm");
  const version = await runInWorkspace([npm, "--version"], workspace.repoRoot, workspace.env, remainingTime(deadlineAt));
  if (version.exitCode !== 0 || version.stdout.trim() !== "11.12.1") throw new Error("npm 11.12.1 required");
  for (const cwd of [workspace.repoRoot, packageRoot]) {
    const result = await runInWorkspace([npm, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], cwd, workspace.env, remainingTime(deadlineAt));
    await writeFile(resolve(workspace.workspaceDir, cwd === packageRoot ? "package-install.json" : "root-install.json"), JSON.stringify(result));
    if (result.exitCode !== 0 || result.signal || result.deadlineFired || result.outputLimitExceeded) throw new Error("offline npm materialization failed; no host fallback");
  }
  const nativeTarget = resolve(packageRoot, "node_modules/better-sqlite3/prebuilds/linux-x64.node");
  await mkdir(dirname(nativeTarget), { recursive: true });
  await cp(preparation.nativeModule, nativeTarget);
  const prerequisite = await runInWorkspace([process.execPath, "--input-type=module", "-e",
    "import Database from 'better-sqlite3'; import { chromium } from 'playwright'; import { existsSync } from 'node:fs'; const db=new Database(':memory:'); db.close(); if(!existsSync(chromium.executablePath())) throw Error('prepared Chromium missing');"], packageRoot, workspace.env, remainingTime(deadlineAt));
  await writeFile(resolve(workspace.workspaceDir, "prerequisites.json"), JSON.stringify(prerequisite));
  if (prerequisite.exitCode !== 0 || prerequisite.signal || prerequisite.outputLimitExceeded) throw new Error("prepared native/browser verification failed");
  await verifyPrepared();
  if (await fileDigest(resolve(workspace.repoRoot, "package-lock.json")) !== rootLock || await fileDigest(resolve(packageRoot, "package-lock.json")) !== packageLock) throw new Error("lock changed during materialization");
  return { rootLock, packageLock, cache: preparation.cacheDigest, browser: preparation.browserDigest, native: preparation.nativeDigest };
}

/**
 * Only called after the caller has already copied+revalidated required
 * evidence out of this workspace. Best-effort verification that no lingering
 * child process remains for this workspace — this is explicitly NOT a
 * sandbox and cannot guarantee no process survives; it can only observe.
 * Then `rm -rf`s the workspace directory. The caller is responsible for
 * marking the attempt destroyed in the evidence store afterward.
 */
export async function destroyWorkspace(workspaceDir: string): Promise<void> {
  await assertNoLingeringProcessBestEffort(workspaceDir);
  await rm(workspaceDir, { recursive: true, force: true });
}

async function assertNoLingeringProcessBestEffort(workspaceDir: string): Promise<void> {
  // Best-effort only: greps the process table for the workspace path. A
  // process that has already exited, or one whose cmdline does not mention
  // the path, is invisible to this check — hence "best-effort", never a
  // sandboxing claim.
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", workspaceDir]);
    const pids = stdout.trim().split("\n").filter(Boolean);
    if (pids.length > 0) {
      throw new Error(
        `destroyWorkspace: ${pids.length} process(es) still reference ${workspaceDir} (pids: ${pids.join(", ")}) — refusing to destroy; quarantine instead`
      );
    }
  } catch (error) {
    const err = error as { code?: number | string };
    // pgrep exits 1 when it finds nothing — that is the expected "no
    // lingering process" case, not a tool failure.
    if (err.code === 1) {
      return;
    }
    if ((error as Error).message?.startsWith("destroyWorkspace:")) {
      throw error;
    }
    // pgrep itself missing/erroring: this is a best-effort check, so a
    // broken check is reported but does not itself block cleanup —
    // matching "this is explicitly NOT a sandbox" rather than pretending an
    // absent tool proves absence of processes.
  }
}

/**
 * Renames/marks a workspace as quarantined instead of deleting it, for any
 * cleanup failure or interruption. A quarantined workspace is never reused
 * or destroyed automatically — a later scan reports it for explicit
 * operator review.
 */
export async function quarantineWorkspace(workspaceDir: string, reason: string): Promise<string> {
  const parent = resolve(workspaceDir, "..");
  const quarantinedDir = resolve(parent, `quarantined-${randomUUID()}-${resolve(workspaceDir).split("/").pop()}`);
  await rename(workspaceDir, quarantinedDir);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    resolve(quarantinedDir, ".quarantine-reason.json"),
    `${JSON.stringify({ reason, quarantinedAt: new Date().toISOString(), originalPath: workspaceDir }, null, 2)}\n`
  );
  return quarantinedDir;
}

/** Lists quarantined workspace directory names directly under `workspaceRoot`, for a reuse-exclusion scan. */
export async function listQuarantinedWorkspaces(workspaceRoot: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  try {
    const entries = await readdir(workspaceRoot);
    return entries.filter((name) => name.startsWith("quarantined-"));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/**
 * Spawns `command` inside `workspace` with a finite wall deadline, killing
 * the owning process group when it fires. Returns captured stdout/stderr,
 * exit code, signal, and whether the deadline fired. This is an
 * adapter-local protection, not a claim of crash-durable containment: a
 * process that ignores SIGTERM/SIGKILL to its own group is outside what
 * this function can prove.
 */
export function runInWorkspace(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  wallTimeMs: number,
  outputByteCap = 8 * 1024 * 1024
): Promise<{ outputLimitExceeded: boolean; deadlineFired: boolean; exitCode: number | null; signal: string | null; stderr: string; stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    if (!Number.isFinite(wallTimeMs) || wallTimeMs <= 0 || !Number.isSafeInteger(outputByteCap) || outputByteCap <= 0) { reject(new Error("invalid execution limits")); return; }
    const [file, ...rest] = command;
    if (!file) {
      reject(new Error("runInWorkspace requires a non-empty command"));
      return;
    }
    const child = spawn(file, rest, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "", stderr = "", capturedBytes = 0;
    let deadlineFired = false, outputLimitExceeded = false;
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } };
    const timer = setTimeout(() => { deadlineFired = true; kill(); }, wallTimeMs);
    const capture = (chunk: Buffer, stream: "stdout" | "stderr") => {
      const remaining = Math.max(0, outputByteCap - capturedBytes);
      const retained = chunk.subarray(0, remaining);
      capturedBytes += retained.length;
      if (stream === "stdout") stdout += retained.toString(); else stderr += retained.toString();
      if (chunk.length > remaining) { outputLimitExceeded = true; kill(); }
    };
    child.stdout?.on("data", (chunk: Buffer) => capture(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => capture(chunk, "stderr"));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code, signal, stdout, stderr, deadlineFired, outputLimitExceeded });
    });
  });
}

/** Exposed for tests only — the OS temp root this file deliberately never uses for real workspace roots. */
export function osTmpdirForTest(): string {
  return osTmpdir();
}

/** Exposed for tests only — a scratch temp dir maker, kept thin so tests never hand-roll their own mktemp logic. */
export function mkdtempForTest(prefix: string): Promise<string> {
  return mkdtemp(prefix);
}
