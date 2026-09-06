// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  aggregateOperatorAttempts,
  cleanupWorkspaceForReceipt,
  commitMutant,
  ForbiddenPathChangeError,
  isMutationAttributable,
  judgeIdentityFor,
  type OperatorAttemptOutcome,
} from "./groupme-runner.ts";
import { GROUPME_NONPROGRESS_WEAKENING_V1, GROUPME_PAGE_CEILING_V1, type GroupMeOperator } from "./groupme-operators.ts";
import type { AttemptAxes, AttemptReceipt } from "./schemas.ts";
import { ATTEMPT_SCHEMA } from "./schemas.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const OK = { status: "ok" } as const;
function baseAxes(overrides: Partial<Omit<AttemptAxes, "cleanup">> = {}): Omit<AttemptAxes, "cleanup"> {
  return { baseline: OK, materialization: OK, focused: OK, backstop: OK, reachability: OK, ...overrides };
}

// ── judgeIdentityFor: deterministic, distinguishes operators ────────────

test("judgeIdentityFor: is deterministic for the same operator", () => {
  assert.equal(judgeIdentityFor(GROUPME_PAGE_CEILING_V1), judgeIdentityFor(GROUPME_PAGE_CEILING_V1));
});

test("judgeIdentityFor: differs between operators and the null (clean-baseline) case", () => {
  const a = judgeIdentityFor(GROUPME_PAGE_CEILING_V1);
  const b = judgeIdentityFor(GROUPME_NONPROGRESS_WEAKENING_V1);
  const c = judgeIdentityFor(null);
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.notEqual(b, c);
});

// ── cleanupWorkspaceForReceipt: real outcome, observed BEFORE any receipt ──
//
// P1-2: the clean-baseline path used to publish `cleanup: { status: "ok" }`
// unconditionally, then destroy the workspace afterward in a `finally`
// block — so a receipt claiming clean cleanup could reach the evidence
// store even when destruction later failed. `cleanupWorkspaceForReceipt` is
// the single shared primitive both the operator-attempt path and the
// clean-baseline path now call; these tests fault-inject a destroy failure
// directly against it, independent of any real filesystem/git workspace.

test("cleanupWorkspaceForReceipt: destroy succeeding returns an ok axis and never quarantines", async () => {
  const calls: string[] = [];
  const axis = await cleanupWorkspaceForReceipt(
    "/fake/workspace",
    async (dir) => {
      calls.push(`destroy:${dir}`);
    },
    async (dir, reason) => {
      calls.push(`quarantine:${dir}:${reason}`);
      return `${dir}-quarantined`;
    }
  );
  assert.deepEqual(axis, { status: "ok" });
  assert.deepEqual(calls, ["destroy:/fake/workspace"]);
});

test("cleanupWorkspaceForReceipt: an injected destroy failure returns a failed axis (never ok) and quarantines", async () => {
  const calls: string[] = [];
  const axis = await cleanupWorkspaceForReceipt(
    "/fake/workspace",
    async () => {
      calls.push("destroy-attempted");
      throw new Error("injected: lingering process still references workspace");
    },
    async (dir, reason) => {
      calls.push(`quarantine:${dir}:${reason}`);
      return `${dir}-quarantined`;
    }
  );
  assert.equal(axis.status, "failed");
  if (axis.status === "failed") {
    assert.equal(axis.failure, "workspace_cleanup_failed");
    assert.match(axis.detail, /injected: lingering process/);
  }
  assert.deepEqual(calls, ["destroy-attempted", "quarantine:/fake/workspace:injected: lingering process still references workspace"]);
});

test("cleanupWorkspaceForReceipt: destroy is fully awaited (real outcome observed) BEFORE the axis is returned — never assumed ahead of time", async () => {
  let destroyCompleted = false;
  const axis = await cleanupWorkspaceForReceipt(
    "/fake/workspace",
    async () => {
      await new Promise((r) => setTimeout(r, 5));
      destroyCompleted = true;
    },
    async (dir) => dir
  );
  // If the caller ever reverted to hardcoding `{ status: "ok" }` ahead of an
  // async destroy, this assertion would still incidentally pass on the
  // happy path — the real proof is the injected-failure test above, which
  // can only pass if the axis reflects destroy's ACTUAL outcome rather
  // than a value fixed before destroy ran.
  assert.equal(destroyCompleted, true);
  assert.deepEqual(axis, { status: "ok" });
});

test("cleanupWorkspaceForReceipt: a quarantine failure does not mask the original cleanup failure", async () => {
  const axis = await cleanupWorkspaceForReceipt(
    "/fake/workspace",
    async () => {
      throw new Error("injected destroy failure");
    },
    async () => {
      throw new Error("injected quarantine failure too");
    }
  );
  assert.equal(axis.status, "failed");
  if (axis.status === "failed") {
    assert.match(axis.detail, /injected destroy failure/);
  }
});

// ── isMutationAttributable: never treats infra/protocol/timeout failures as mutation signal ──

test("isMutationAttributable: a genuine focused test-assertion failure is attributable", () => {
  const axes = baseAxes({ focused: { status: "failed", failure: "focused_check_test_failure", detail: "" } });
  assert.equal(isMutationAttributable(axes), true);
});

test("isMutationAttributable: a preimage-mismatch failure is NOT attributable (infra, not mutation signal)", () => {
  const axes = baseAxes({ focused: { status: "failed", failure: "preimage_mismatch_or_apply_failure", detail: "" } });
  assert.equal(isMutationAttributable(axes), false);
});

test("isMutationAttributable: a materialization-triggered focused failure is NOT attributable", () => {
  const axes = baseAxes({ focused: { status: "failed", failure: "not_run_due_to_materialization_failure", detail: "" } });
  assert.equal(isMutationAttributable(axes), false);
});

test("isMutationAttributable: a wall-deadline timeout is NOT attributable", () => {
  const axes = baseAxes({ focused: { status: "failed", failure: "focused_check_wall_deadline_exceeded", detail: "" } });
  assert.equal(isMutationAttributable(axes), false);
});

test("isMutationAttributable: a backstop authority error is NOT attributable", () => {
  const axes = baseAxes({ backstop: { status: "failed", failure: "backstop_authority_error", detail: "" } });
  assert.equal(isMutationAttributable(axes), false);
});

test("isMutationAttributable: a rejected backstop never supplies end-to-end selector-miss attribution", () => {
  const axes = baseAxes({ focused: OK, backstop: { status: "failed", failure: "owning_test_assertion_failure", detail: "" } });
  assert.equal(isMutationAttributable(axes), false);
});

// ── aggregateOperatorAttempts: contradictory attempts -> inconclusive ────

function fakeReceipt(): AttemptReceipt {
  return {
    schema: ATTEMPT_SCHEMA,
    attemptId: "00000000-0000-0000-0000-000000000000",
    trialKey: "a".repeat(64),
    intentDigest: "e".repeat(64),
    policyVersion: "v1",
    baseCommitSha: "b".repeat(40),
    mutantIdentity: "c".repeat(40),
    judgeIdentity: "d".repeat(64),
    environmentProfile: [],
    evidenceArtifacts: [],
    axes: { baseline: OK, materialization: OK, focused: OK, backstop: OK, reachability: OK, cleanup: OK },
    runtimeMs: 1,
    attemptStatus: { exitCode: 0, signal: null },
    referencedAccountingRunIds: [],
  };
}

test("aggregateOperatorAttempts: agreeing outcomes for the same operator return the shared verdict", () => {
  const outcomes: OperatorAttemptOutcome[] = [
    { attemptId: "1", operatorId: "groupme-page-ceiling-dc-v1", receipt: fakeReceipt(), projection: { projection: "killed" } },
    { attemptId: "2", operatorId: "groupme-page-ceiling-dc-v1", receipt: fakeReceipt(), projection: { projection: "killed" } },
  ];
  assert.deepEqual(aggregateOperatorAttempts(outcomes), { projection: "killed" });
});

test("aggregateOperatorAttempts: contradictory outcomes (killed vs survived) for the same operator are inconclusive", () => {
  const outcomes: OperatorAttemptOutcome[] = [
    { attemptId: "1", operatorId: "groupme-page-ceiling-dc-v1", receipt: fakeReceipt(), projection: { projection: "killed" } },
    { attemptId: "2", operatorId: "groupme-page-ceiling-dc-v1", receipt: fakeReceipt(), projection: { projection: "survived" } },
  ];
  const result = aggregateOperatorAttempts(outcomes);
  assert.equal(result.projection, "inconclusive");
  assert.equal(result.failingAxis, "contradictory_trial_key");
});

// P1-5: two "killed" outcomes that disagree on selectorMiss must surface
// as a disagreement, not silently collapse to whichever attempt is first —
// this is the exact reviewer-flagged gap (a broad-projection-only compare
// would have treated these as agreeing).
test("aggregateOperatorAttempts: killed-with-selectorMiss vs killed-without is a disagreement, not a silent pick", () => {
  const withMiss: OperatorAttemptOutcome = {
    attemptId: "1",
    operatorId: "groupme-page-ceiling-dc-v1",
    receipt: fakeReceipt(),
    projection: { projection: "killed", selectorMiss: true },
  };
  const withoutMiss: OperatorAttemptOutcome = {
    attemptId: "2",
    operatorId: "groupme-page-ceiling-dc-v1",
    receipt: fakeReceipt(),
    projection: { projection: "killed" },
  };
  const forward = aggregateOperatorAttempts([withMiss, withoutMiss]);
  const reversed = aggregateOperatorAttempts([withoutMiss, withMiss]);
  assert.equal(forward.projection, "inconclusive");
  assert.deepEqual(forward, reversed);
});

// ── commitMutant: forbidden-path enforcement (fault injection, tasks.md 2.5) ──

async function makeMiniGroupMeLikeRepo(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "mutation-falsification-runner-test-"));
  git(["init", "-q", "-b", "main"], repoRoot);
  git(["config", "user.email", "test@example.com"], repoRoot);
  git(["config", "user.name", "Test"], repoRoot);
  const targetDir = resolve(repoRoot, "packages/polyfill-connectors/connectors/groupme");
  await mkdir(targetDir, { recursive: true });
  await writeFile(resolve(targetDir, "index.ts"), "export const marker = 1;\n");
  git(["add", "-A"], repoRoot);
  git(["commit", "-q", "-m", "initial"], repoRoot);
  return repoRoot;
}

test("commitMutant: throws ForbiddenPathChangeError if applying an operator would touch an unexpected path", async () => {
  const repoRoot = await makeMiniGroupMeLikeRepo();
  try {
    // A deliberately misconfigured operator whose applyPostimage writes to a
    // SECOND file outside its own declared target — proving the runner's own
    // path-scope check refuses this rather than silently committing it.
    const misconfiguredOperator: GroupMeOperator = {
      id: "test-forbidden-path-operator",
      version: "1",
      targetFile: "packages/polyfill-connectors/connectors/groupme/index.ts",
      preimage: "export const marker = 1;\n",
      riskDescription: "test fixture: writes outside its declared target",
      applyPostimage: (content: string) => {
        // Side effect outside the declared target file — this is exactly
        // what a forbidden-path change looks like.
        writeFileSync(resolve(repoRoot, "UNEXPECTED.txt"), "should never be committed\n");
        return content.replace("export const marker = 1;", "export const marker = 2;");
      },
    };
    await assert.rejects(() => commitMutant(repoRoot, misconfiguredOperator), ForbiddenPathChangeError);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("commitMutant: a well-scoped operator commits cleanly as a real one-commit descendant", async () => {
  const repoRoot = await makeMiniGroupMeLikeRepo();
  try {
    const headBefore = git(["rev-parse", "HEAD"], repoRoot);
    const wellScopedOperator: GroupMeOperator = {
      id: "test-well-scoped-operator",
      version: "1",
      targetFile: "packages/polyfill-connectors/connectors/groupme/index.ts",
      preimage: "export const marker = 1;\n",
      riskDescription: "test fixture: well-scoped change",
      applyPostimage: (content: string) => content.replace("export const marker = 1;", "export const marker = 2;"),
    };
    const mutantSha = await commitMutant(repoRoot, wellScopedOperator);
    assert.notEqual(mutantSha, headBefore);
    const parentSha = git(["rev-parse", `${mutantSha}^`], repoRoot);
    assert.equal(parentSha, headBefore, "the mutant must be a one-commit descendant of the base commit");
    const changedFiles = git(["diff", "--name-only", headBefore, mutantSha], repoRoot).split("\n").filter(Boolean);
    assert.deepEqual(changedFiles, ["packages/polyfill-connectors/connectors/groupme/index.ts"]);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("commitMutant: propagates PreimageMismatchError when the operator's preimage does not match", async () => {
  const repoRoot = await makeMiniGroupMeLikeRepo();
  try {
    const mismatchedOperator: GroupMeOperator = {
      id: "test-mismatched-operator",
      version: "1",
      targetFile: "packages/polyfill-connectors/connectors/groupme/index.ts",
      preimage: "this text does not exist in the target file",
      riskDescription: "test fixture: preimage mismatch",
      applyPostimage: (content: string) => content,
    };
    await assert.rejects(() => commitMutant(repoRoot, mismatchedOperator));
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("unrecognized focused and all rejected backstop failures stay unattributable", () => {
  assert.equal(isMutationAttributable(baseAxes({ focused: {status:"failed", failure:"focused_loader_error",detail:""} })), false);
  assert.equal(isMutationAttributable(baseAxes({ backstop: {status:"failed",failure:"owning_test_assertion_failure",detail:""} })), false);
});

test("preflight cost boundary validates retained bytes and identity before admitting 300 seconds", async () => {
  const { admitMeasuredBatch, retainObservation } = await import("./groupme-runner.ts");
  const root = await mkdtemp(join(tmpdir(), "groupme-cost-"));
  try {
    const artifact = await retainObservation({evidenceRoot:root,maxAttempts:20,maxRetainedBytes:100000,retentionDeadlineDays:30}, "fixture", "receipt", {receipt:"fixture"});
    const cost = {schema:"data-connectors/groupme-clean-cost/v1" as const,identity:"fixture",startedAt:1,endedAt:300001,elapsedMs:300000,artifacts:[artifact],namespaceAvailable:true,verified:true};
    assert.equal((await admitMeasuredBatch(cost,"fixture",root,300001)).admitted,true);
    assert.equal((await admitMeasuredBatch({...cost,endedAt:300002,elapsedMs:300001},"fixture",root,300002)).reason,"clean_backstop_exceeds_300_seconds");
    assert.equal((await admitMeasuredBatch(undefined,"fixture",root,300001)).admitted,false);
    assert.equal((await admitMeasuredBatch(cost,"different",root,300001)).admitted,false);
    assert.equal((await admitMeasuredBatch(cost,"fixture",root,8_000_000)).admitted,false);
    await writeFile(resolve(root,artifact.relativePath),"tampered");
    assert.equal((await admitMeasuredBatch(cost,"fixture",root,300001)).reason,"changed_clean_receipt_bytes");
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("authority subprocess sees private HOME TMPDIR cache and no ambient credential sentinel", async () => {
  const { symlink, readFile } = await import("node:fs/promises");
  const { runCompleteBackstop } = await import("./groupme-runner.ts");
  const { buildIsolatedEnvironment } = await import("./workspace.ts");
  const root = await mkdtemp(join(tmpdir(), "groupme-env-"));
  const old = process.env.GROUPME_SECRET_SENTINEL;
  process.env.GROUPME_SECRET_SENTINEL = "ambient-secret";
  try {
    git(["init","-q"],root);
    await mkdir(resolve(root,"scripts/test-accounting"),{recursive:true});
    await writeFile(resolve(root,"package.json"),'{"type":"module"}');
    await symlink(resolve(import.meta.dirname,"../../node_modules"),resolve(root,"node_modules"),"dir");
    await writeFile(resolve(root,"scripts/test-accounting/authority.ts"),`export async function runAuthority(options) {
      console.log('ENV_SENTINEL '+JSON.stringify({home:process.env.HOME,tmp:process.env.TMPDIR,cache:options.env.npm_config_cache,secret:process.env.GROUPME_SECRET_SENTINEL??null}));
      throw new Error('fixture authority rejection');
    }`);
    const env = buildIsolatedEnvironment(resolve(root,"private"),{environmentAllowlist:[]});
    const policy={evidenceRoot:resolve(root,"evidence"),maxAttempts:20,maxRetainedBytes:1000000,retentionDeadlineDays:30 as const};
    const result=await runCompleteBackstop(root,policy,"fixture",env,5000);
    assert.equal(result.axis.status,"failed");
    const observation=JSON.parse(await readFile(resolve(policy.evidenceRoot,result.artifacts[0]!.relativePath),"utf8"));
    const sentinel=JSON.parse(observation.stdout.split('\n').find((line:string)=>line.startsWith('ENV_SENTINEL ')).slice(13));
    assert.deepEqual(sentinel,{home:env.HOME,tmp:env.TMPDIR,cache:env.npm_config_cache,secret:null});
  } finally {
    if(old===undefined)delete process.env.GROUPME_SECRET_SENTINEL;else process.env.GROUPME_SECRET_SENTINEL=old;
    await rm(root,{recursive:true,force:true});
  }
});

test("focused classification refuses timeout signal loader and incomplete event populations", async () => {
  const {classifyFocusedResult}=await import("./groupme-runner.ts");
  const clean={exitCode:0,signal:null,stdout:"",stderr:"",deadlineFired:false,outputLimitExceeded:false};
  for(const overrides of [{deadlineFired:true},{signal:"SIGTERM"},{exitCode:1},{outputLimitExceeded:true}]) {
    assert.notEqual(classifyFocusedResult({...clean,...overrides},GROUPME_PAGE_CEILING_V1).failure,"focused_check_test_failure");
  }
  assert.equal(classifyFocusedResult(clean,null).ok,false);
});

test("judge identity binds actual raw bytes including binary files", async () => {
  const root=await mkdtemp(join(tmpdir(),"groupme-identity-"));
  try {
    git(["init","-q"],root);
    const files=["packages/polyfill-connectors/connectors/groupme/incremental-frontier.test.ts","package-lock.json","packages/polyfill-connectors/package-lock.json","scripts/mutation-falsification/groupme-runner.ts","scripts/mutation-falsification/groupme-operators.ts","scripts/mutation-falsification/workspace.ts","scripts/test-accounting/authority.ts","scripts/test-accounting/receipt.ts","scripts/test-accounting/inventory.ts","scripts/test-accounting/node-reporter.ts","binary.dat"];
    for(const file of files){await mkdir(resolve(root,file,".."),{recursive:true});await writeFile(resolve(root,file),"fixture");}
    git(["add","-A"],root);
    await writeFile(resolve(root,"binary.dat"),Buffer.from([0xff]));
    const before=judgeIdentityFor(null,root);
    await writeFile(resolve(root,"binary.dat"),Buffer.from([0xfe]));
    assert.notEqual(judgeIdentityFor(null,root),before,"distinct invalid UTF8 bytes must remain distinct");
    const binaryChanged=judgeIdentityFor(null,root);
    await writeFile(resolve(root,files[0]!),"changed judge");
    assert.notEqual(judgeIdentityFor(null,root),binaryChanged);
  } finally {await rm(root,{recursive:true,force:true});}
});

test("failed preflight CLI retains one blocked pilot and two not-run operators before exiting nonzero", async () => {
  const {cp,readFile,readdir}=await import("node:fs/promises");
  const root=await mkdtemp(join(tmpdir(),"groupme-driver-failure-"));
  try {
    const scriptDir=resolve(root,"scripts/mutation-falsification");
    await mkdir(scriptDir,{recursive:true});
    await cp(resolve(import.meta.dirname,"run-groupme-pilot.ts"),resolve(scriptDir,"run-groupme-pilot.ts"));
    await writeFile(resolve(scriptDir,"canonicalize.ts"),'export const digestOf=()=>"fixture-identity";');
    await writeFile(resolve(scriptDir,"groupme-operators.ts"),'export const GROUPME_OPERATORS=[{id:"first"},{id:"second"}];');
    await writeFile(resolve(scriptDir,"schemas.ts"),'export const freezeIntentPacket=x=>x; export const INTENT_SCHEMA="fixture";');
    await writeFile(resolve(scriptDir,"groupme-runner.ts"),`export const GROUPME_PILOT_ADAPTER_ID='fixture',GROUPME_PILOT_ADAPTER_VERSION='fixture',PILOT_BATCH_WALL_TIME_MS=600000;
      export const judgeIdentityFor=()=>"fixture";
      export const aggregateOperatorAttempts=()=>null;
      export const runGroupMePilotBatch=()=>{throw Error('operators must not run')};
      export const retainObservation=async()=>({relativePath:'fixture',byteSize:0,sha256:'fixture'});
      export const admitMeasuredBatch=async()=>({admitted:false,reason:'unverified_clean_authority'});
      export const runCompleteBackstop=async()=>({axis:{status:'failed',failure:'backstop_authority_error',detail:'fixture failure'},artifacts:[],runIds:[]});`);
    await writeFile(resolve(scriptDir,"workspace.ts"),`export const defaultWorkspacePolicy=()=>({workspaceRoot:${JSON.stringify(resolve(root,"workspace"))}});
      export const buildIsolatedEnvironment=(root)=>({HOME:root+'/home',TMPDIR:root+'/tmp',npm_config_userconfig:root+'/npmrc',npm_config_globalconfig:root+'/global-npmrc',PLAYWRIGHT_BROWSERS_PATH:root+'/browsers'});
      export const directoryDigest=async()=>"fixture";
      export const fileDigest=async()=>"fixture";
      export const runInWorkspace=async()=>({exitCode:1,signal:null});`);
    await writeFile(resolve(root,"package.json"),'{"type":"module"}');
    await writeFile(resolve(root,".gitignore"),'.mutation-falsification-evidence/\nworkspace/\nbrowser/\n');
    await mkdir(resolve(root,"browser"));
    git(["init","-q"],root);git(["add","-A"],root);
    git(["-c","user.name=Fixture","-c","user.email=fixture@localhost","commit","-qm","driver fixture"],root);
    let exitCode=0;
    try { execFileSync(process.execPath,[resolve(scriptDir,"run-groupme-pilot.ts"),"--preflight"],{cwd:root,env:{...process.env,MUTATION_PREFLIGHT_BROWSER_SOURCE:resolve(root,"browser")},stdio:"pipe"}); }
    catch(error){exitCode=(error as {status:number}).status;}
    assert.notEqual(exitCode,0);
    const preflightRoot=resolve(root,".mutation-falsification-evidence/preflight");
    const runs=(await readdir(preflightRoot)).filter(name=>!name.endsWith('.json'));
    assert.equal(runs.length,1);
    const marker=JSON.parse(await readFile(resolve(preflightRoot,runs[0]!,"admission.json"),"utf8"));
    assert.equal(marker.blockedPilotCount,1);
    assert.deepEqual(marker.notRunOperators,["first","second"]);
    assert.equal(marker.interpretedTrials,0);
    assert.equal(marker.admitted,false);
  } finally {await rm(root,{recursive:true,force:true});}
});
