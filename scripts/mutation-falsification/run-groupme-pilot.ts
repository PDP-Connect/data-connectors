// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** One local batch; --preflight measures clean authority only. Neither mode certifies triage. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, release, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { digestOf } from "./canonicalize.ts";
import { GROUPME_OPERATORS } from "./groupme-operators.ts";
import {
  admitMeasuredBatch, aggregateOperatorAttempts, type CleanBackstopCost,
  GROUPME_PILOT_ADAPTER_ID, GROUPME_PILOT_ADAPTER_VERSION, judgeIdentityFor,
  PILOT_BATCH_WALL_TIME_MS, retainObservation, runCompleteBackstop, runGroupMePilotBatch,
} from "./groupme-runner.ts";
import { freezeIntentPacket, INTENT_SCHEMA } from "./schemas.ts";
import { buildIsolatedEnvironment, defaultWorkspacePolicy, directoryDigest, fileDigest, runInWorkspace, type PreparedDependencies } from "./workspace.ts";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const EVIDENCE_ROOT = resolve(REPO_ROOT, ".mutation-falsification-evidence");
const POLICY_VERSION = "data-connectors/groupme-cursor-frontier/v1";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--preflight")) throw new Error("only --preflight is accepted");
  if (process.version !== "v24.15.0") throw new Error("Node 24.15.0 is required");
  const npm = resolve(dirname(process.execPath), "npm");
  const npmVersion = execFileSync(npm, ["--version"], { encoding: "utf8" }).trim();
  if (npmVersion !== "11.12.1") throw new Error("npm 11.12.1 is required");
  const baseCommitSha = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (execFileSync("git", ["-C", REPO_ROOT, "status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("clean committed source required");
  const operatorIds = GROUPME_OPERATORS.map(op => op.id);
  const runId = randomUUID();
  const workspacePolicy = defaultWorkspacePolicy();
  const privateRoot = resolve(workspacePolicy.workspaceRoot, `preflight-${runId}`);
  await mkdir(resolve(privateRoot, "home"), { recursive: true });
  await mkdir(resolve(privateRoot, "tmp"), { recursive: true });
  const env = buildIsolatedEnvironment(privateRoot, { environmentAllowlist: ["CI"] });
  await writeFile(env.npm_config_userconfig!, "");
  await writeFile(env.npm_config_globalconfig!, "");
  const browserSource = process.env.MUTATION_PREFLIGHT_BROWSER_SOURCE;
  if (!browserSource) throw new Error("MUTATION_PREFLIGHT_BROWSER_SOURCE must explicitly name prepared Chromium bytes");
  const browserDigest = await directoryDigest(resolve(browserSource));
  await cp(resolve(browserSource), env.PLAYWRIGHT_BROWSERS_PATH!, { recursive: true });
  if (await directoryDigest(env.PLAYWRIGHT_BROWSERS_PATH!) !== browserDigest || await directoryDigest(resolve(browserSource)) !== browserDigest) throw new Error("prepared browser copy identity changed");
  const nativeDigest = await fileDigest(resolve(REPO_ROOT, "packages/polyfill-connectors/node_modules/better-sqlite3/prebuilds/linux-x64.node"));
  const plan = {
    schema: "data-connectors/groupme-effective-plan/v1", baseCommitSha, policy: POLICY_VERSION,
    node: { version: process.version, executableDigest: await fileDigest(process.execPath) },
    npm: { version: npmVersion, executableDigest: await fileDigest(npm) },
    host: { platform: platform(), release: release(), arch: arch() },
    browserDigest, nativeDigest,
    judgeIdentity: judgeIdentityFor(null), manifestDigest: await fileDigest(resolve(REPO_ROOT, "test-accounting.manifest.json")),
    rootLock: await fileDigest(resolve(REPO_ROOT, "package-lock.json")),
    packageLock: await fileDigest(resolve(REPO_ROOT, "packages/polyfill-connectors/package-lock.json")),
    authority: { suites: ["polyfill-connectors"], profile: "default", cwd: REPO_ROOT },
    materializationCommands: [".", "packages/polyfill-connectors"].map(cwd => ({ cwd, argv: [npm, "ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"] })),
    environmentConfiguration: Object.fromEntries(Object.entries(env).map(([name,value]) => [name,
      typeof value === "string" ? value.replaceAll(privateRoot, "<private-workspace>") : value])),
    focusedCommand: [process.execPath,"--test","--import","tsx","--test-reporter","scripts/test-accounting/node-reporter.ts","packages/polyfill-connectors/connectors/groupme/incremental-frontier.test.ts"], batchWallTimeMs: PILOT_BATCH_WALL_TIME_MS,
    cleanCostAdmissionMaximumMs: 300_000,
  };
  const identity = digestOf(plan);
  const evidenceStorePolicy = { evidenceRoot: EVIDENCE_ROOT, maxAttempts: 20, maxRetainedBytes: 2 * 1024 ** 3, retentionDeadlineDays: 30 as const };
  const runDirectory = resolve(EVIDENCE_ROOT, "preflight", runId);
  await mkdir(runDirectory, { recursive: true });
  await writeFile(resolve(runDirectory, "effective-plan.json"), JSON.stringify(plan, null, 2) + "\n");
  const costPath = resolve(EVIDENCE_ROOT, "preflight", "latest-clean-backstop-cost.json");
  let cost: CleanBackstopCost | undefined;
  if (args.includes("--preflight")) {
    const startedAt = Date.now();
    const backstop = await runCompleteBackstop(REPO_ROOT, evidenceStorePolicy, runId, env, 630_000);
    const endedAt = Date.now();
    const namespace = await runInWorkspace(["/usr/bin/unshare", "-r", "-n", "true"], REPO_ROOT, env, 10_000);
    const capabilityArtifact = await retainObservation(evidenceStorePolicy, runId, "namespace-capability", namespace);
    cost = { schema: "data-connectors/groupme-clean-cost/v1", identity, startedAt, endedAt,
      elapsedMs: endedAt - startedAt, artifacts: [...backstop.artifacts, capabilityArtifact],
      namespaceAvailable: namespace.exitCode === 0 && !namespace.signal, verified: backstop.axis.status === "ok" };
    await writeFile(resolve(runDirectory, "clean-backstop-cost.json"), JSON.stringify(cost, null, 2) + "\n");
    if (!cost.verified) {
      await writeFile(resolve(runDirectory, "admission.json"), JSON.stringify({ admitted: false,
        reason: "clean_authority_failed", blockedPilotCount: 1, operatorAttempts: 0,
        notRunOperators: operatorIds, interpretedTrials: 0, identity }, null, 2) + "\n");
      throw new Error(`clean authority failed; retained unverified observations at ${runDirectory}`);
    }
    await writeFile(costPath, JSON.stringify(cost, null, 2) + "\n");
  } else {
    try { cost = JSON.parse(await readFile(costPath, "utf8")); } catch { /* Missing measurement refuses admission below. */ }
  }
  const admission = await admitMeasuredBatch(cost, identity, EVIDENCE_ROOT);
  const stop = { ...admission, blockedPilotCount: admission.admitted ? 0 : 1, operatorAttempts: 0, notRunOperators: operatorIds, interpretedTrials: 0, costPath, identity };
  await writeFile(resolve(runDirectory, "admission.json"), JSON.stringify(stop, null, 2) + "\n");
  if (args.includes("--preflight") || !admission.admitted) {
    console.log("MUTATION_PILOT_BATCH_RESULT", JSON.stringify({ ...stop, preflightOnly: args.includes("--preflight"), recommendation: "NARROW" }));
    if (!args.includes("--preflight")) process.exitCode = 1;
    return;
  }
  // Prepared bytes must be explicitly retained and reviewed; no ambient dependency/cache fallback.
  const preparationPath = resolve(EVIDENCE_ROOT, "prepared-dependencies.json");
  const preparation = JSON.parse(await readFile(preparationPath, "utf8")) as PreparedDependencies;
  const policy = { evidenceStorePolicy, policyVersion: POLICY_VERSION, sourceRepoRoot: REPO_ROOT, effectivePlan: plan,
    workspacePolicy: { ...workspacePolicy, preparation } };
  const intent = freezeIntentPacket({ schema: INTENT_SCHEMA, adapterId: GROUPME_PILOT_ADAPTER_ID,
    adapterVersion: GROUPME_PILOT_ADAPTER_VERSION, baseCommitSha, operatorId: null,
    requestedRisk: "groupme-cursor-frontier-pilot-batch",
    requestedBudget: { wallTimeMs: PILOT_BATCH_WALL_TIME_MS, directOutputByteCap: 8 * 1024 ** 2 } });
  const result = await runGroupMePilotBatch(policy, intent, operatorIds);
  console.log("MUTATION_PILOT_BATCH_RESULT", JSON.stringify({ ...result, verdictByOperator: Object.fromEntries(operatorIds.map(id => [id, aggregateOperatorAttempts(result.operatorOutcomes.filter(o => o.operatorId === id))])) }));
}

main().catch(error => { console.error("groupme pilot stopped:", error); process.exitCode = 1; });
