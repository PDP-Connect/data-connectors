// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Orchestrates ONE GroupMe pilot batch (design.md Decision #6/#7, tasks.md
 * section 2). Locks a 10-minute wall-clock batch window; runs the clean
 * complete `polyfill-connectors` backstop through the UNCHANGED
 * test-accounting authority against a clean isolated clone before
 * interpreting any mutant; for each registered operator, creates a fresh
 * isolated clone, applies the operator (verifying its exact preimage
 * first), commits the mutant as a real one-commit descendant, runs the
 * FOCUSED existing hermetic test file(s) as adapter evidence (never
 * labeled a test-accounting authority receipt), and — only if focused
 * passes — runs the MANDATORY complete mutant backstop. Copies and
 * revalidates every accounting bundle into the evidence store before
 * destroying each clone.
 *
 * Mutant batches run only in independent clones. The explicit preflight
 * measures authority on the current clean committed checkout without operators.
 */

import { execFile, execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { runAuthority } from "../test-accounting/authority.ts";
import { digestOf } from "./canonicalize.ts";
import {
  beginAttempt,
  checkBudget,
  copyAndRevalidateAccountingBundle,
  type EvidenceStorePolicy,
  publishCompleteReceipt,
} from "./evidence-store.ts";
import { applyOperator, findGroupMeOperator, type GroupMeOperator } from "./groupme-operators.ts";
import { aggregateTrial, type ProjectionResult, projectOutcome } from "./projection.ts";
import { ATTEMPT_SCHEMA, type AttemptAxes, type AttemptReceipt, type IntentPacket } from "./schemas.ts";
import {
  buildIsolatedEnvironment,
  createIsolatedWorkspace,
  destroyWorkspace,
  fileDigest,
  materializeDependencies,
  remainingTime,
  type IsolatedWorkspace,
  quarantineWorkspace,
  runInWorkspace,
  type WorkspacePolicy,
} from "./workspace.ts";

const execFileAsync = promisify(execFile);

export const GROUPME_PILOT_ADAPTER_ID = "data-connectors/groupme-cursor-frontier/v1" as const;
export const GROUPME_PILOT_ADAPTER_VERSION = "2" as const;
export const PILOT_BATCH_WALL_TIME_MS = 10 * 60 * 1000;
const FOCUSED_TEST_FILE = "packages/polyfill-connectors/connectors/groupme/incremental-frontier.test.ts";
const BACKSTOP_SUITE_ID = "polyfill-connectors";
/** Reuse window for a clean baseline within one locked batch (design.md Decision #6). */
const CLEAN_EVIDENCE_REUSE_WINDOW_MS = 2 * 60 * 60 * 1000;

export interface GroupMeRunnerPolicy {
  evidenceStorePolicy: EvidenceStorePolicy;
  policyVersion: string;
  effectivePlan?: unknown;
  sourceRepoRoot: string;
  workspacePolicy: WorkspacePolicy;
}

export interface OperatorAttemptOutcome {
  attemptId: string;
  operatorId: string;
  projection: ProjectionResult;
  receipt: AttemptReceipt;
}

export interface PilotBatchResult {
  /** Raw count of clean-baseline EXECUTIONS actually performed — never reduced by reuse, per design.md Decision #6. */
  cleanExecutionRawCount: number;
  operatorOutcomes: OperatorAttemptOutcome[];
}

export function judgeIdentityFor(operator: GroupMeOperator | null, root = resolve(import.meta.dirname, "../..")): string {
  const tracked = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const explicit = [FOCUSED_TEST_FILE, "package-lock.json", "packages/polyfill-connectors/package-lock.json",
    "scripts/mutation-falsification/groupme-runner.ts", "scripts/mutation-falsification/groupme-operators.ts",
    "scripts/mutation-falsification/workspace.ts", "scripts/test-accounting/authority.ts",
    "scripts/test-accounting/receipt.ts", "scripts/test-accounting/inventory.ts", "scripts/test-accounting/node-reporter.ts"];
  const files = [...new Set([...tracked, ...explicit])].filter(p => p !== "packages/polyfill-connectors/connectors/groupme/index.ts").sort();
  return digestOf({ files: files.map(path => [path, createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex")]),
    focusedCommand: focusedCommand(root), backstopSuite: BACKSTOP_SUITE_ID, profile: "default",
    operator: operator ? { id: operator.id, version: operator.version, preimage: operator.preimage,
      postimage: operator.applyPostimage(operator.preimage) } : null });
}

function focusedCommand(repoRoot: string): string[] {
  return [process.execPath, "--test", "--import", "tsx", "--test-reporter",
    resolve(repoRoot, "scripts/test-accounting/node-reporter.ts"), FOCUSED_TEST_FILE];
}
const OWNING_TESTS: Record<string, string> = {
  "groupme-page-ceiling-dc-v1": ">old-cap discriminator: a group's forward walk pages past 200 full pages with no truncation (mutation-killing)",
  "groupme-nonprogress-weakening-dc-v1": "repeated/nonprogressing cursor: a forward page violating documented ascending order fails as NonProgressError",
};

export function classifyFocusedResult(result: Awaited<ReturnType<typeof runInWorkspace>>, operator: GroupMeOperator | null): { ok: boolean; failure?: string } {
  if (result.deadlineFired) return { ok: false, failure: "focused_check_wall_deadline_exceeded" };
  if (result.signal || result.outputLimitExceeded) return { ok: false, failure: "focused_interrupted_or_output_limit" };
  let events: Array<{type: string; details: {name?: string; skip?: unknown; failure?: {code?: string; failure_type?: string; message?: string}}}>;
  try {
    const lines = result.stdout.trim().split("\n");
    if (!lines.length || lines.some(line => !line.startsWith("PDPP_TEST_ACCOUNTING_EVENT "))) throw Error();
    events = lines.map(line => JSON.parse(line.slice("PDPP_TEST_ACCOUNTING_EVENT ".length)));
    if (events.some(e => !e.details || !["test:pass", "test:fail"].includes(e.type) || typeof e.details.name !== "string" || e.details.skip)) throw Error();
    if (new Set(events.map(e => e.details.name)).size !== events.length) throw Error();
  } catch { return { ok: false, failure: "focused_malformed_output" }; }
  if (events.length !== 23) return { ok: false, failure: "focused_incomplete_population" };
  const failures = events.filter(e => e.type === "test:fail");
  if (result.exitCode === 0 && failures.length === 0) return { ok: true };
  if (result.exitCode === 1 && operator && failures.length === 1 &&
      failures[0]!.details.name === OWNING_TESTS[operator.id] &&
      failures[0]!.details.failure?.code === "ERR_TEST_FAILURE" &&
      failures[0]!.details.failure?.message === (operator.id === "groupme-page-ceiling-dc-v1" ? "no cap-truncation past 200 pages\n\ntrue !== false\n" : "a non-ascending forward page must fail, not be silently trusted\n\nfalse !== true\n") &&
      failures[0]!.details.failure?.failure_type === "testCodeFailure") return { ok: false, failure: "focused_check_test_failure" };
  return { ok: false, failure: "focused_unrecognized_failure" };
}

export async function runFocusedCheck(repoRoot: string, env: NodeJS.ProcessEnv, wallTimeMs: number, operator: GroupMeOperator | null = null) {
  const deadlineAt = Date.now() + wallTimeMs;
  const status = async () => (await execFileAsync("/usr/bin/git", ["-C", repoRoot, "status", "--porcelain=v1", "--untracked-files=all"],
    { env, timeout: remainingTime(deadlineAt), encoding: "utf8" })).stdout;
  const sourceStatusBefore = await status();
  if (sourceStatusBefore.trim()) return { ok: false, failure: "focused_source_not_clean", sourceStatusBefore,
    stdout: "", stderr: "", exitCode: null, signal: null, deadlineFired: false, outputLimitExceeded: false };
  const result = await runInWorkspace(focusedCommand(repoRoot), repoRoot, env, remainingTime(deadlineAt));
  if (result.deadlineFired || result.signal || result.outputLimitExceeded) return { ...result, sourceStatusBefore, ...classifyFocusedResult(result, operator) };
  let sourceStatusAfter: string;
  try { sourceStatusAfter = await status(); }
  catch (error) { return { ...result, sourceStatusBefore, ok: false, failure: "focused_source_validation_failed", validationError: String(error) }; }
  return { ...result, sourceStatusBefore, sourceStatusAfter,
    ...(sourceStatusAfter.trim() ? { ok: false, failure: "focused_source_changed" } : classifyFocusedResult(result, operator)) };
}

export async function retainObservation(policy: EvidenceStorePolicy, attemptId: string, name: string, value: unknown): Promise<AttemptReceipt["evidenceArtifacts"][number]> {
  const relativePath = `attempts/${attemptId}/${name}.json`;
  const path = resolve(policy.evidenceRoot, relativePath);
  await mkdir(resolve(path, ".."), { recursive: true });
  const bytes = JSON.stringify(value, null, 2) + "\n";
  await checkBudget(policy, Buffer.byteLength(bytes));
  await writeFile(path, bytes, { flag: "wx" });
  return { relativePath, byteSize: Buffer.byteLength(bytes), sha256: await fileDigest(path) };
}

/**
 * Runs the clean COMPLETE `polyfill-connectors` backstop via the real,
 * unchanged `runAuthority` against `repoRoot` (an isolated clone). Copies
 * and revalidates its accounting bundle into the evidence store. Returns
 * the axis observation plus the accounting run_id(s) referenced, for
 * embedding in an attempt receipt.
 *
 * `runAuthority`'s own `base` option is NOT this pilot's base/mutant commit
 * — it is an optional cross-check that the checked-out repo's own
 * `test-accounting.manifest.json`'s declared `inventory_base_sha` equals a
 * caller-expected value (a manifest-drift guard). This pilot has no
 * separately-expected value to assert here (the clone's manifest is
 * whatever the checked-out commit already carries), so `base` is
 * deliberately omitted rather than misused as "the commit to run against."
 */
export async function runCompleteBackstop(
  repoRoot: string, evidenceStorePolicy: EvidenceStorePolicy, attemptId: string,
  env: NodeJS.ProcessEnv, wallTimeMs: number
): Promise<{ artifacts: AttemptReceipt["evidenceArtifacts"]; axis: AttemptAxes["backstop"]; runIds: string[]; interrupted: boolean; attemptStatus: AttemptReceipt["attemptStatus"] }> {
  const directory = resolve(execFileSync("git", ["-C", repoRoot, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim(), "test-accounting/runs");
  const prior = new Set(await readdir(directory).catch(() => [] as string[]));
  const code = `import {runAuthority} from ${JSON.stringify(pathToFileURL(resolve(repoRoot, "scripts/test-accounting/authority.ts")).href)};
    try { const result=await runAuthority({root:process.cwd(),suites:["polyfill-connectors"],profile:"default",env:process.env});
      console.log("GROUPME_AUTHORITY_RESULT "+JSON.stringify(result)); }
    catch(error){console.error(String(error));process.exitCode=1;}`;
  const command = [process.execPath, "--import", "tsx", "--input-type=module", "-e", code];
  const observed = await runInWorkspace(command, repoRoot, env, wallTimeMs);
  const artifacts: AttemptReceipt["evidenceArtifacts"] = [await retainObservation(evidenceStorePolicy, attemptId, "authority-process", { ...observed, command, cwd: repoRoot, environment: env })];
  const fresh = (await readdir(directory).catch(() => [] as string[])).filter(name => !prior.has(name));
  // Failed/incomplete bytes are retained as unverified observations, never successful receipts.
  for (const name of fresh) {
    if (!(await lstat(resolve(directory, name))).isFile()) continue; // The authority owns its separate verified replay ledger.
    artifacts.push(await retainObservation(evidenceStorePolicy, attemptId, `unverified-${name}`, { sourceName: name, bytes: await readFile(resolve(directory, name), "utf8") }));
  }
  const interrupted = observed.deadlineFired || !!observed.signal || observed.outputLimitExceeded;
  const attemptStatus = { exitCode: observed.exitCode, signal: observed.signal };
  const failed = (failure: string, detail: string) => ({ artifacts, interrupted, attemptStatus, axis: { status: "failed" as const, failure, detail }, runIds: [] });
  if (observed.exitCode !== 0 || observed.signal || observed.deadlineFired || observed.outputLimitExceeded) return failed("backstop_authority_error", "authority rejected or interrupted; retained observations are unverified");
  try {
    const lines = observed.stdout.split("\n").filter(line => line.startsWith("GROUPME_AUTHORITY_RESULT "));
    if (lines.length !== 1) throw new Error("missing/duplicate authority result");
    const outcome = JSON.parse(lines[0]!.slice("GROUPME_AUTHORITY_RESULT ".length)) as Awaited<ReturnType<typeof runAuthority>>;
    if (outcome.directory !== directory || JSON.stringify(outcome.result.verified) !== JSON.stringify(["polyfill-connectors/default"])) throw new Error("wrong verified authority selection");
    const receipts = fresh.filter(name => name.endsWith(".receipt.json"));
    if (receipts.length !== 1) throw new Error("expected exactly one fresh receipt");
    const receipt = JSON.parse(await readFile(resolve(directory, receipts[0]!), "utf8"));
    if (receipt.suite !== "polyfill-connectors" || receipt.profile !== "default" || receipt.exit_code !== 0) throw new Error("wrong clean receipt identity");
    artifacts.push(...await copyAndRevalidateAccountingBundle(evidenceStorePolicy.evidenceRoot, attemptId, directory, receipt.run_id));
    return { artifacts, interrupted, attemptStatus, axis: { status: "ok" }, runIds: [receipt.run_id] };
  } catch (error) { return failed("backstop_artifact_retention_failed", String(error)); }
}

export class ForbiddenPathChangeError extends Error {
  constructor(operatorId: string, changedPaths: string[]) {
    super(
      `groupme-runner: operator ${operatorId} would change path(s) outside its declared target — refusing to commit: ${changedPaths.join(", ")}`
    );
    this.name = "ForbiddenPathChangeError";
  }
}

export async function commitMutant(repoRoot: string, operator: GroupMeOperator,
  env = buildIsolatedEnvironment(resolve(repoRoot,".."), {environmentAllowlist:[]}), deadlineAt = Date.now()+120_000): Promise<string> {
  const gitOptions = { env, timeout: remainingTime(deadlineAt) };
  const targetPath = resolve(repoRoot, operator.targetFile);
  const original = await readFile(targetPath, "utf8");
  const mutated = applyOperator(operator, original); // throws PreimageMismatchError on any mismatch — verified BEFORE any write.
  await writeFile(targetPath, mutated, "utf8");
  // Defense in depth: verify the working tree's changed paths are EXACTLY
  // the operator's declared target, before staging or committing anything.
  // An operator entry could in principle be authored to write outside its
  // declared path; this check makes that a hard, caught error rather than
  // a silent wider change slipping into the mutant commit.
  const { stdout: statusOutput } = await execFileAsync("git", ["-C", repoRoot, "status", "--porcelain=v1"], gitOptions);
  const changedPaths = statusOutput
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).trim());
  const unexpected = changedPaths.filter((path) => path !== operator.targetFile);
  if (unexpected.length > 0) {
    throw new ForbiddenPathChangeError(operator.id, unexpected);
  }
  await execFileAsync("git", ["-C", repoRoot, "add", "--", operator.targetFile], gitOptions);
  await execFileAsync("git", [
    "-C",
    repoRoot,
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=mutation-falsification",
    "-c",
    "user.email=mutation-falsification@localhost",
    "commit",
    "-q",
    "-m",
    `mutation-falsification: local synthetic experiment ${operator.id}`,
  ], gitOptions);
  const { stdout } = await execFileAsync("git", ["-C", repoRoot, "rev-parse", "HEAD"], gitOptions);
  return stdout.trim();
}

/**
 * Runs one operator attempt end to end inside a fresh isolated workspace:
 * apply + commit the mutant, run the focused check, and — only if focused
 * passes — the mandatory complete mutant backstop. Destroys the workspace
 * only after required evidence is copied+revalidated; quarantines on any
 * cleanup failure.
 */
interface AttemptComputation {
  quarantineRequired?: boolean;
  interrupted?: boolean;
  attemptStatus?: AttemptReceipt["attemptStatus"];
  evidenceArtifacts: AttemptReceipt["evidenceArtifacts"];
  mutantCommitSha: string;
  nonCleanupAxes: Omit<AttemptAxes, "cleanup">;
  referencedAccountingRunIds: string[];
}

async function computeOperatorAttempt(
  workspace: IsolatedWorkspace,
  operator: GroupMeOperator,
  policy: GroupMeRunnerPolicy,
  attemptId: string,
  deadlineAt: number
): Promise<AttemptComputation> {
  try {
    await materializeDependencies(workspace, policy.workspacePolicy.preparation, deadlineAt);
  } catch (error) {
    return {
      mutantCommitSha: "",
      quarantineRequired: true,
      evidenceArtifacts: await retainSetupObservations(workspace, policy.evidenceStorePolicy, attemptId),
      referencedAccountingRunIds: [],
      nonCleanupAxes: {
        baseline: { status: "ok" },
        materialization: {
          status: "failed",
          failure: "dependency_materialization_failed",
          detail: (error as Error).message,
        },
        focused: { status: "failed", failure: "not_run_due_to_materialization_failure", detail: "focused check did not run because dependency materialization failed" },
        backstop: { status: "not_applicable" },
        reachability: { status: "unknown" },
      },
    };
  }

  let mutantCommitSha: string;
  try {
    mutantCommitSha = await commitMutant(workspace.repoRoot, operator, workspace.env, deadlineAt);
  } catch (error) {
    return {
      mutantCommitSha: "",
      evidenceArtifacts: [],
      referencedAccountingRunIds: [],
      nonCleanupAxes: {
        baseline: { status: "ok" },
        materialization: { status: "ok" },
        focused: { status: "failed", failure: "preimage_mismatch_or_apply_failure", detail: (error as Error).message },
        backstop: { status: "not_applicable" },
        reachability: { status: "unknown" },
      },
    };
  }

  const focused = await runFocusedCheck(workspace.repoRoot, workspace.env, remainingTime(deadlineAt), operator);
  const focusedArtifact = await retainObservation(policy.evidenceStorePolicy, attemptId, "focused", focused);
  if (!focused.ok) {
    // Only the exact registered owning assertion supplies attributable evidence.
    return {
      mutantCommitSha,
      quarantineRequired: focused.deadlineFired || !!focused.signal || focused.outputLimitExceeded,
      interrupted: focused.deadlineFired || !!focused.signal || focused.outputLimitExceeded,
      attemptStatus: { exitCode: focused.exitCode, signal: focused.signal },
      evidenceArtifacts: [focusedArtifact],
      referencedAccountingRunIds: [],
      nonCleanupAxes: {
        baseline: { status: "ok" },
        materialization: { status: "ok" },
        focused: {
          status: "failed",
          failure: focused.failure ?? "focused_check_failed",
          detail: focused.stdout.slice(-4000),
        },
        backstop: { status: focused.failure === "focused_check_test_failure" ? "not_run_focused_kill" : "not_applicable" },
        reachability: { status: focused.failure === "focused_check_test_failure" ? "ok" : "unknown" },
      },
    };
  }

  // Focused passed — the mandatory complete mutant backstop now runs. The
  // clone is already checked out at the mutant commit (commitMutant left
  // HEAD there), so runAuthority observes the mutated tree without any
  // further checkout here.
  const backstopResult = await runCompleteBackstop(workspace.repoRoot, policy.evidenceStorePolicy, attemptId, workspace.env, remainingTime(deadlineAt, PILOT_BATCH_WALL_TIME_MS));
  return {
    mutantCommitSha,
    quarantineRequired: backstopResult.interrupted,
    interrupted: backstopResult.interrupted,
    attemptStatus: backstopResult.attemptStatus,
    evidenceArtifacts: [focusedArtifact, ...backstopResult.artifacts],
    referencedAccountingRunIds: backstopResult.runIds,
    nonCleanupAxes: {
      baseline: { status: "ok" },
      materialization: { status: "ok" },
      focused: { status: "ok" },
      backstop: backstopResult.axis,
      reachability: { status: "ok" },
    },
  };
}

export function isMutationAttributable(axes: Omit<AttemptAxes, "cleanup">): boolean {
  return axes.focused.status === "failed" && axes.focused.failure === "focused_check_test_failure";
}

/**
 * Destroys `workspaceDir` and reports its REAL, already-observed outcome as
 * a cleanup axis — never a hardcoded `{ status: "ok" }` assumed ahead of
 * time. On failure, quarantines the workspace (best-effort) and returns a
 * `failed` axis instead of throwing, so the caller can still publish an
 * honest (non-`ok`) receipt rather than leaving the attempt marker
 * incomplete forever. Shared by every call site that must publish a receipt
 * only after cleanup has actually run — `runOperatorAttempt` and the
 * clean-baseline step of `runGroupMePilotBatch` both call this, so neither
 * can drift back into publishing `cleanup: ok` before cleanup completes.
 */
export async function cleanupWorkspaceForReceipt(
  workspaceDir: string,
  destroy: (dir: string) => Promise<void> = destroyWorkspace,
  quarantine: (dir: string, reason: string) => Promise<string> = quarantineWorkspace
): Promise<AttemptAxes["cleanup"]> {
  try {
    await destroy(workspaceDir);
    return { status: "ok" };
  } catch (error) {
    const detail = (error as Error).message;
    await quarantine(workspaceDir, detail).catch(() => undefined);
    return { status: "failed", failure: "workspace_cleanup_failed", detail };
  }
}

/**
 * Runs one operator attempt end to end inside a fresh isolated workspace:
 * apply + commit the mutant, run the focused check, and — only if focused
 * passes — the mandatory complete mutant backstop. Cleanup (destroy or
 * quarantine the workspace) happens BEFORE the receipt is published, so the
 * receipt's cleanup axis always reflects a REAL, already-observed outcome —
 * never a hardcoded assumption that cleanup will succeed later.
 */
async function runOperatorAttempt(
  policy: GroupMeRunnerPolicy,
  intent: IntentPacket,
  operatorId: string,
  baseCommitSha: string,
  deadlineAt: number,
  cleanArtifacts: AttemptReceipt["evidenceArtifacts"]
): Promise<OperatorAttemptOutcome> {
  const operator = findGroupMeOperator(operatorId);
  await checkBudget(policy.evidenceStorePolicy, 50 * 1024 * 1024); // 50 MiB planning estimate for one attempt's retained evidence.
  const attemptId = await beginAttempt(policy.evidenceStorePolicy.evidenceRoot, intent);

  const startedAt = Date.now();
  const workspace = await createIsolatedWorkspace(policy.workspacePolicy, policy.sourceRepoRoot, baseCommitSha, deadlineAt);
  let computation: AttemptComputation;
  try { computation = await computeOperatorAttempt(workspace, operator, policy, attemptId, deadlineAt); }
  catch (error) { await quarantineWorkspace(workspace.workspaceDir, String(error)); throw error; }

  const cleanupAxis: AttemptAxes["cleanup"] = computation.quarantineRequired
    ? (await quarantineWorkspace(workspace.workspaceDir, "setup failed or test phase interrupted"), { status: "failed", failure: "workspace_quarantined_after_interruption", detail: "manual review required" })
    : await cleanupWorkspaceForReceipt(workspace.workspaceDir);

  const axes: AttemptAxes = { ...computation.nonCleanupAxes, cleanup: cleanupAxis };
  const runtimeMs = Date.now() - startedAt;
  const trialKey = digestOf({
    intentDigest: intent.intentDigest,
    adapterVersion: GROUPME_PILOT_ADAPTER_VERSION,
    policyVersion: policy.policyVersion,
    operatorId,
  });
  const receipt: AttemptReceipt = {
    schema: ATTEMPT_SCHEMA,
    attemptId,
    trialKey,
    intentDigest: intent.intentDigest,
    policyVersion: policy.policyVersion,
    baseCommitSha,
    mutantIdentity: computation.mutantCommitSha || null,
    judgeIdentity: judgeIdentityFor(operator, policy.sourceRepoRoot),
    environmentProfile: Object.keys(workspace.env),
    evidenceArtifacts: [...cleanArtifacts, ...computation.evidenceArtifacts],
    axes,
    runtimeMs,
    attemptStatus: computation.attemptStatus ?? { exitCode: null, signal: null },
    referencedAccountingRunIds: computation.referencedAccountingRunIds,
  };
  const projection = projectOutcome({
    axes,
    isMutationAttributableFailure: isMutationAttributable(computation.nonCleanupAxes),
  });
  if (computation.interrupted) {
    await retainObservation(policy.evidenceStorePolicy, attemptId, "interrupted-attempt", receipt);
    throw new Error("mutant test phase interrupted; workspace quarantined and attempt incomplete");
  }
  await publishCompleteReceipt(policy.evidenceStorePolicy.evidenceRoot, receipt);
  return { attemptId, operatorId, receipt, projection };
}

/** Clean focused + authority executions precede all operators; each reuse checks retained bytes and judge identity. */
export async function runGroupMePilotBatch(
  policy: GroupMeRunnerPolicy,
  intent: IntentPacket,
  operatorIds: string[]
): Promise<PilotBatchResult> {
  await mkdir(policy.workspacePolicy.workspaceRoot, { recursive: true });
  if ((await readdir(policy.workspacePolicy.workspaceRoot)).some(name => name.startsWith("attempt-") || name.startsWith("quarantined-"))) throw new Error("groupme batch blocked by unresolved workspace; manual review required");
  const batchStartedAt = Date.now();
  const deadlineAt = batchStartedAt + Math.min(PILOT_BATCH_WALL_TIME_MS, intent.requestedBudget.wallTimeMs);
  const cleanIdentity = judgeIdentityFor(null, policy.sourceRepoRoot);
  for (const id of operatorIds) findGroupMeOperator(id);
  if (new Set(operatorIds).size !== operatorIds.length) throw new Error("duplicate operator request");
  await mkdir(policy.evidenceStorePolicy.evidenceRoot, { recursive: true });

  // Clean complete backstop at batch start. Mirrors runOperatorAttempt's
  // discipline exactly: cleanup (destroy or quarantine the workspace) runs
  // and its REAL outcome is observed BEFORE the receipt is built, so the
  // published receipt's cleanup axis is never a hardcoded assumption — a
  // failed cleanup here yields a `cleanup: failed` receipt (which
  // projection.ts's row 1 always resolves to inconclusive), never a
  // `cleanup: ok` receipt published ahead of the destroy actually running.
  const cleanBackstopAttemptId = await beginAttempt(policy.evidenceStorePolicy.evidenceRoot, intent);
  const cleanWorkspace = await createIsolatedWorkspace(
    policy.workspacePolicy,
    policy.sourceRepoRoot,
    intent.baseCommitSha,
    deadlineAt
  );
  let cleanExecutionRawCount = 0;
  const planArtifact = await retainObservation(policy.evidenceStorePolicy, cleanBackstopAttemptId, "effective-plan", {
    policyVersion: policy.policyVersion, adapterVersion: GROUPME_PILOT_ADAPTER_VERSION,
    baseCommitSha: intent.baseCommitSha, judgeIdentity: cleanIdentity,
    preparation: policy.workspacePolicy.preparation ?? null, declaredPlan: policy.effectivePlan ?? null,
    focusedCommand: focusedCommand(cleanWorkspace.repoRoot), batchWallTimeMs: deadlineAt - batchStartedAt,
    environment: cleanWorkspace.env, nodeDigest: await fileDigest(process.execPath),
  });

  let cleanResult:
    | Awaited<ReturnType<typeof runCompleteBackstop>>
    | undefined;
  let materializationError: Error | undefined;
  try {
    await materializeDependencies(cleanWorkspace, policy.workspacePolicy.preparation, deadlineAt);
    const focused = await runFocusedCheck(cleanWorkspace.repoRoot, cleanWorkspace.env, remainingTime(deadlineAt));
    const focusedArtifact = await retainObservation(policy.evidenceStorePolicy, cleanBackstopAttemptId, "clean-focused", focused);
    if (!focused.ok) throw new Error(`clean focused check failed: ${focused.failure}`);
    cleanResult = await runCompleteBackstop(cleanWorkspace.repoRoot, policy.evidenceStorePolicy,
      cleanBackstopAttemptId, cleanWorkspace.env, remainingTime(deadlineAt, PILOT_BATCH_WALL_TIME_MS));
    cleanResult.artifacts.push(planArtifact, focusedArtifact);
    cleanExecutionRawCount += 1;
  } catch (error) {
    materializationError = error as Error;
  }

  if (materializationError) {
    await retainSetupObservations(cleanWorkspace, policy.evidenceStorePolicy, cleanBackstopAttemptId);
    await retainObservation(policy.evidenceStorePolicy, cleanBackstopAttemptId, "clean-setup-failure", { error: materializationError.message });
    await quarantineWorkspace(cleanWorkspace.workspaceDir, materializationError.message);
    throw new Error(`clean setup failed before operators; workspace quarantined: ${materializationError.message}`);
  }
  if (cleanResult?.interrupted) {
    await retainObservation(policy.evidenceStorePolicy, cleanBackstopAttemptId, "interrupted-clean", {
      axis: cleanResult.axis, attemptStatus: cleanResult.attemptStatus, cleanExecutionRawCount, artifacts: cleanResult.artifacts,
    });
    await quarantineWorkspace(cleanWorkspace.workspaceDir, "clean backstop interrupted");
    throw new Error("clean backstop interrupted; workspace quarantined and attempt incomplete");
  }
  const cleanupAxis = await cleanupWorkspaceForReceipt(cleanWorkspace.workspaceDir);

  if (!cleanResult) {
    throw new Error("groupme-runner: clean complete backstop produced no result despite no recorded error");
  }
  if (cleanResult.axis.status !== "ok") {
    throw new Error(
      `groupme-runner: clean complete backstop failed before any mutant was interpreted: ${JSON.stringify(cleanResult.axis)}`
    );
  }

  const cleanReceipt: AttemptReceipt = {
    schema: ATTEMPT_SCHEMA,
    attemptId: cleanBackstopAttemptId,
    trialKey: digestOf({
      intentDigest: intent.intentDigest,
      kind: "clean-backstop",
      baseCommitSha: intent.baseCommitSha,
    }),
    intentDigest: intent.intentDigest,
    policyVersion: policy.policyVersion,
    baseCommitSha: intent.baseCommitSha,
    mutantIdentity: null,
    judgeIdentity: cleanIdentity,
    environmentProfile: Object.keys(cleanWorkspace.env),
    evidenceArtifacts: cleanResult.artifacts,
    axes: {
      baseline: { status: "ok" },
      materialization: { status: "ok" },
      focused: { status: "ok" },
      backstop: cleanResult.axis,
      reachability: { status: "not_applicable" },
      cleanup: cleanupAxis,
    },
    runtimeMs: Date.now() - batchStartedAt,
    attemptStatus: { exitCode: 0, signal: null },
    referencedAccountingRunIds: cleanResult.runIds,
  };
  await publishCompleteReceipt(policy.evidenceStorePolicy.evidenceRoot, cleanReceipt);
  if (cleanupAxis.status !== "ok") {
    // The receipt is honest evidence (cleanup: failed), but a failed
    // cleanup at the mandatory clean baseline still means no mutant may be
    // interpreted — matching "stop or narrow on any cleanup failure"
    // (design.md tasks.md 3.2).
    throw new Error(
      `groupme-runner: clean complete backstop's workspace cleanup failed — published as cleanup: failed, but refusing to proceed to any operator: ${JSON.stringify(cleanupAxis)}`
    );
  }

  const operatorOutcomes: OperatorAttemptOutcome[] = [];
  for (const operatorId of operatorIds) {
    if (Date.now() - batchStartedAt > PILOT_BATCH_WALL_TIME_MS) {
      throw new Error("groupme-runner: 10-minute locked pilot batch window exceeded before all operators ran");
    }
    // biome-ignore lint/performance/noAwaitInLoops: operators run sequentially by design (initial policy: "one trusted command at a time").
    if (Date.now() - batchStartedAt > CLEAN_EVIDENCE_REUSE_WINDOW_MS || cleanIdentity !== judgeIdentityFor(null, policy.sourceRepoRoot)) throw new Error("clean evidence identity or reuse window changed");
    for (const artifact of cleanResult.artifacts) {
      if (await fileDigest(resolve(policy.evidenceStorePolicy.evidenceRoot, artifact.relativePath)) !== artifact.sha256) throw new Error("clean evidence bytes changed");
    }
    const outcome = await runOperatorAttempt(policy, intent, operatorId, intent.baseCommitSha, deadlineAt, cleanResult.artifacts);
    operatorOutcomes.push(outcome);
    if (outcome.receipt.axes.cleanup.status !== "ok") throw new Error("groupme batch stopped after failed cleanup; no later operator may run");
  }

  return { operatorOutcomes, cleanExecutionRawCount };
}

/** Combines multiple attempts for the same operator into one trial verdict — no retries, contradictory attempts are inconclusive. See projection.ts's aggregateTrial. */
export function aggregateOperatorAttempts(outcomes: OperatorAttemptOutcome[]): ProjectionResult {
  return aggregateTrial(outcomes.map((o) => o.projection));
}

export const CLEAN_EVIDENCE_REUSE_WINDOW_MS_EXPORT = CLEAN_EVIDENCE_REUSE_WINDOW_MS;

export interface CleanBackstopCost {
  schema: "data-connectors/groupme-clean-cost/v1";
  identity: string;
  startedAt: number;
  endedAt: number;
  elapsedMs: number;
  artifacts: AttemptReceipt["evidenceArtifacts"];
  namespaceAvailable: boolean;
  verified: boolean;
}

export async function admitMeasuredBatch(
  cost: CleanBackstopCost | undefined, identity: string, evidenceRoot: string, now = Date.now()
): Promise<{ admitted: boolean; reason: string }> {
  if (!cost || cost.schema !== "data-connectors/groupme-clean-cost/v1" || cost.identity !== identity || !cost.verified) return { admitted: false, reason: "missing_or_wrong_identity_clean_cost" };
  if (!Number.isSafeInteger(cost.elapsedMs) || cost.elapsedMs < 0 || cost.endedAt - cost.startedAt !== cost.elapsedMs || cost.endedAt > now || now - cost.endedAt > CLEAN_EVIDENCE_REUSE_WINDOW_MS) return { admitted: false, reason: "stale_or_invalid_clean_cost" };
  if (!cost.artifacts.length) return { admitted: false, reason: "missing_clean_receipt_bytes" };
  for (const artifact of cost.artifacts) {
    const path = resolve(evidenceRoot, artifact.relativePath);
    if (!path.startsWith(resolve(evidenceRoot) + "/")) return { admitted: false, reason: "invalid_artifact_path" };
    try {
      const bytes = await readFile(path);
      if (bytes.length !== artifact.byteSize || await fileDigest(path) !== artifact.sha256) return { admitted: false, reason: "changed_clean_receipt_bytes" };
    } catch { return { admitted: false, reason: "missing_clean_receipt_bytes" }; }
  }
  if (cost.elapsedMs > 300_000) return { admitted: false, reason: "clean_backstop_exceeds_300_seconds" };
  if (!cost.namespaceAvailable) return { admitted: false, reason: "namespace_capability_unavailable" };
  return { admitted: true, reason: "cost_and_capability_admitted" };
}

async function retainSetupObservations(workspace: IsolatedWorkspace, policy: EvidenceStorePolicy, attemptId: string): Promise<AttemptReceipt["evidenceArtifacts"]> {
  const artifacts: AttemptReceipt["evidenceArtifacts"] = [];
  for (const name of ["root-install", "package-install", "prerequisites"]) {
    let bytes: string;
    try { bytes = await readFile(resolve(workspace.workspaceDir, `${name}.json`), "utf8"); }
    catch(error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    artifacts.push(await retainObservation(policy, attemptId, name, JSON.parse(bytes)));
  }
  return artifacts;
}
