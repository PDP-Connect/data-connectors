// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  buildIsolatedEnvironment,
  createIsolatedWorkspace,
  defaultWorkspacePolicy,
  destroyWorkspace,
  gitCommonDirFor,
  listQuarantinedWorkspaces,
  quarantineWorkspace,
  runInWorkspace,
  type WorkspacePolicy,
} from "./workspace.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Builds a tiny, real, standalone (non-worktree) git repo to clone from — cheap and fully independent, so this test never touches the real PDPP repository's actual object store. */
async function makeSourceRepo(): Promise<{ headSha: string; sourceRepoRoot: string }> {
  const sourceRepoRoot = await mkdtemp(join(tmpdir(), "mutation-falsification-source-"));
  git(["init", "-q", "-b", "main"], sourceRepoRoot);
  git(["config", "user.email", "test@example.com"], sourceRepoRoot);
  git(["config", "user.name", "Test"], sourceRepoRoot);
  await writeFile(resolve(sourceRepoRoot, "package-lock.json"), '{"lockfileVersion":3}\n');
  await writeFile(resolve(sourceRepoRoot, "hello.txt"), "hello\n");
  git(["add", "-A"], sourceRepoRoot);
  git(["commit", "-q", "-m", "initial"], sourceRepoRoot);
  const headSha = git(["rev-parse", "HEAD"], sourceRepoRoot);
  return { sourceRepoRoot, headSha };
}

async function withTempWorkspaceRoot(fn: (root: string) => Promise<void>): Promise<void> {
  // Real disk-backed temp dir under the OS temp root, for this test's OWN
  // throwaway workspace policy — production policy defaults to
  // ~/.tmp/mutation-falsification/ (see defaultWorkspaceRoot), but the test
  // must not litter that shared, potentially-real-evidence-adjacent path.
  const root = await mkdtemp(join(tmpdir(), "mutation-falsification-workspace-test-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("createIsolatedWorkspace: clone's git common-dir is independent of the source repo's", async () => {
  const { sourceRepoRoot, headSha } = await makeSourceRepo();
  try {
    await withTempWorkspaceRoot(async (workspaceRoot) => {
      const policy: WorkspacePolicy = {
        workspaceRoot,
        minFreeBytesPreflight: 1024,
        environmentAllowlist: [],
      };
      const workspace = await createIsolatedWorkspace(policy, sourceRepoRoot, headSha);
      try {
        const sourceCommonDir = gitCommonDirFor(sourceRepoRoot);
        const cloneCommonDir = gitCommonDirFor(workspace.repoRoot);
        assert.notEqual(cloneCommonDir, sourceCommonDir);
        assert.ok(
          cloneCommonDir.startsWith(resolve(workspace.workspaceDir)),
          `clone's git common-dir ${cloneCommonDir} must resolve under the workspace ${workspace.workspaceDir}`
        );
        // Mutating the clone must never touch the source repo.
        await writeFile(resolve(workspace.repoRoot, "hello.txt"), "mutated\n");
        git(["add", "-A"], workspace.repoRoot);
        git(["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-q", "-m", "mutant"], workspace.repoRoot);
        const sourceHeadAfter = git(["rev-parse", "HEAD"], sourceRepoRoot);
        assert.equal(sourceHeadAfter, headSha, "mutating the clone must not affect the source repo's HEAD");
      } finally {
        await destroyWorkspace(workspace.workspaceDir);
      }
    });
  } finally {
    await rm(sourceRepoRoot, { recursive: true, force: true });
  }
});

test("buildIsolatedEnvironment: starts from empty, never inherits an unlisted host var (credential-sentinel)", () => {
  const hostEnv: NodeJS.ProcessEnv = {
    HOME: "/home/real-host-user",
    PATH: "/usr/bin",
    SECRET_API_KEY: "sk-should-never-appear",
    AWS_SECRET_ACCESS_KEY: "also-should-never-appear",
  };
  const env = buildIsolatedEnvironment("/workspace/attempt-1", { environmentAllowlist: [] }, hostEnv);
  // Sentinel host values must be ABSENT or explicitly overridden to the
  // isolated value — never passed through ambiently.
  assert.notEqual(env.HOME, hostEnv.HOME);
  assert.ok(env.HOME?.startsWith("/workspace/attempt-1"));
  assert.equal(env.SECRET_API_KEY, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
});

test("buildIsolatedEnvironment: passes through only policy-allowlisted names, with their real values", () => {
  const hostEnv: NodeJS.ProcessEnv = { HOME: "/home/real", NODE_ENV: "test", SECRET_TOKEN: "shh" };
  const env = buildIsolatedEnvironment("/workspace/attempt-2", { environmentAllowlist: ["NODE_ENV"] }, hostEnv);
  assert.equal(env.NODE_ENV, "test");
  assert.equal(env.SECRET_TOKEN, undefined);
});

test("buildIsolatedEnvironment: every WRITABLE attempt-local path resolves beneath the workspace directory", () => {
  const env = buildIsolatedEnvironment("/workspace/attempt-3", { environmentAllowlist: [] }, { PATH: "/usr/bin" });
  for (const key of ["HOME", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "npm_config_cache", "npm_config_userconfig", "PLAYWRIGHT_BROWSERS_PATH"]) {
    assert.ok(env[key]?.startsWith("/workspace/attempt-3"), `${key} must resolve under the workspace: ${env[key]}`);
  }
});

test("buildIsolatedEnvironment: host package caches and config are never inherited", () => {
  const env = buildIsolatedEnvironment("/workspace/attempt-4", { environmentAllowlist: [] },
    { npm_config_cache: "/host/cache", COREPACK_HOME: "/host/corepack", NODE_OPTIONS: "--require=host" });
  assert.equal(env.npm_config_cache, "/workspace/attempt-4/npm-cache");
  assert.equal(env.COREPACK_HOME, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
});

test("defaultWorkspacePolicy: default workspace root is not under /tmp", () => {
  const policy = defaultWorkspacePolicy();
  assert.ok(!policy.workspaceRoot.startsWith("/tmp/"), `workspace root must not be RAM-backed: ${policy.workspaceRoot}`);
});

test("quarantineWorkspace: a quarantined workspace is excluded from a subsequent scan for reuse", async () => {
  await withTempWorkspaceRoot(async (workspaceRoot) => {
    const fakeAttemptDir = resolve(workspaceRoot, "attempt-abc");
    await mkdir(fakeAttemptDir, { recursive: true });
    await writeFile(resolve(fakeAttemptDir, "marker.txt"), "was mid-run\n");
    const quarantinedDir = await quarantineWorkspace(fakeAttemptDir, "cleanup interrupted mid-run");
    const quarantined = await listQuarantinedWorkspaces(workspaceRoot);
    assert.equal(quarantined.length, 1);
    assert.ok(quarantinedDir.includes("quarantined-"));
  });
});

test("runInWorkspace: kills the process group and reports deadlineFired when the wall deadline is exceeded", async () => {
  const result = await runInWorkspace(["sleep", "5"], process.cwd(), { PATH: process.env.PATH ?? "" }, 200);
  assert.equal(result.deadlineFired, true);
  assert.notEqual(result.exitCode, 0);
});

test("runInWorkspace: a command that finishes well within budget reports deadlineFired: false", async () => {
  const result = await runInWorkspace(["true"], process.cwd(), { PATH: process.env.PATH ?? "" }, 5000);
  assert.equal(result.deadlineFired, false);
  assert.equal(result.exitCode, 0);
});

test("destination environment cannot override private paths or inject runtime configuration", () => {
  for (const name of ["HOME", "PATH", "NODE_OPTIONS", "npm_config_userconfig", "AWS_SECRET_ACCESS_KEY"]) {
    assert.throws(() => buildIsolatedEnvironment("/workspace/private", { environmentAllowlist: [name] }, { [name]: "ambient" }));
  }
});

test("direct output cap stops a flooding child before buffering unbounded bytes", async () => {
  const result = await runInWorkspace([process.execPath, "-e", "setInterval(()=>process.stdout.write('x'.repeat(65536)),0)"], process.cwd(), {}, 2000, 1024);
  assert.equal(result.outputLimitExceeded, true);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 1024);
  assert.equal(result.deadlineFired, false);
});

test("materializer refuses absent preparation and expired phase budgets", async () => {
  const {materializeDependencies,remainingTime}=await import("./workspace.ts");
  await assert.rejects(()=>materializeDependencies({repoRoot:"/unused",workspaceDir:"/unused",env:{}},undefined,Date.now()+1000),/verified cache\/browser\/native preparation/);
  assert.throws(()=>remainingTime(Date.now()-1),/deadline exceeded/);
});

test("prepared inventory rejects symlinks and changes when bytes change", async () => {
  const {directoryDigest}=await import("./workspace.ts");
  const {symlink}=await import("node:fs/promises");
  await withTempWorkspaceRoot(async root=>{
    await writeFile(resolve(root,"package"),"first");
    const first=await directoryDigest(root);
    await writeFile(resolve(root,"package"),"second");
    assert.notEqual(await directoryDigest(root),first);
    await symlink("/etc/passwd",resolve(root,"outside"));
    await assert.rejects(()=>directoryDigest(root),/symlink/);
  });
});

test("materializer executes both locked npm roots offline and refuses an unseeded package without sharing bytes", async () => {
  const {readFile,stat}=await import("node:fs/promises");
  const {directoryDigest,fileDigest,materializeDependencies}=await import("./workspace.ts");
  await withTempWorkspaceRoot(async root=>{
    const repoRoot=resolve(root,"repo"),packageRoot=resolve(repoRoot,"packages/polyfill-connectors");
    const cacheRoot=resolve(root,"prepared-cache"),browserRoot=resolve(root,"prepared-browser"),workspaceDir=resolve(root,"workspace");
    for(const dir of [repoRoot,packageRoot,cacheRoot,browserRoot,workspaceDir])await mkdir(dir,{recursive:true});
    const rootPackage={name:"offline-root-fixture",version:"1.0.0"};
    await writeFile(resolve(repoRoot,"package.json"),JSON.stringify(rootPackage));
    await writeFile(resolve(repoRoot,"package-lock.json"),JSON.stringify({...rootPackage,lockfileVersion:3,packages:{"":rootPackage}}));
    const packageManifest={name:"offline-package-fixture",version:"1.0.0",dependencies:{"groupme-unseeded-fixture":"1.0.0"}};
    await writeFile(resolve(packageRoot,"package.json"),JSON.stringify(packageManifest));
    await writeFile(resolve(packageRoot,"package-lock.json"),JSON.stringify({name:packageManifest.name,version:"1.0.0",lockfileVersion:3,packages:{"":packageManifest,"node_modules/groupme-unseeded-fixture":{version:"1.0.0",resolved:"https://registry.npmjs.org/groupme-unseeded-fixture/-/groupme-unseeded-fixture-1.0.0.tgz"}}}));
    await writeFile(resolve(browserRoot,"chromium"),"prepared browser fixture");
    const nativeModule=resolve(root,"native.node");await writeFile(nativeModule,"fixture");
    const env=buildIsolatedEnvironment(workspaceDir,{environmentAllowlist:[]});
    for(const path of [env.HOME!,env.TMPDIR!])await mkdir(path,{recursive:true});
    await writeFile(env.npm_config_userconfig!,"");await writeFile(env.npm_config_globalconfig!,"");
    const preparation={cacheRoot,cacheDigest:await directoryDigest(cacheRoot),browserRoot,browserDigest:await directoryDigest(browserRoot),nativeModule,nativeDigest:await fileDigest(nativeModule),rootLockDigest:await fileDigest(resolve(repoRoot,"package-lock.json")),packageLockDigest:await fileDigest(resolve(packageRoot,"package-lock.json"))};
    await assert.rejects(()=>materializeDependencies({repoRoot,workspaceDir,env},preparation,Date.now()+20000),/offline npm materialization failed/);
    const rootInstall=JSON.parse(await readFile(resolve(workspaceDir,"root-install.json"),"utf8"));
    const packageInstall=JSON.parse(await readFile(resolve(workspaceDir,"package-install.json"),"utf8"));
    assert.equal(rootInstall.exitCode,0);
    assert.notEqual(packageInstall.exitCode,0);
    assert.match(packageInstall.stderr,/ENOTCACHED|cache mode is 'only-if-cached'/);
    assert.equal(await directoryDigest(cacheRoot),preparation.cacheDigest,"source cache unchanged");
    const original=await stat(resolve(browserRoot,"chromium")),copied=await stat(resolve(env.PLAYWRIGHT_BROWSERS_PATH!,"chromium"));
    assert.notEqual(`${original.dev}:${original.ino}`,`${copied.dev}:${copied.ino}`);
    await writeFile(resolve(env.PLAYWRIGHT_BROWSERS_PATH!,"chromium"),"mutated private bytes");
    assert.equal(await readFile(resolve(browserRoot,"chromium"),"utf8"),"prepared browser fixture");
  });
});
