// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classifyTrackedPath } from "./inventory.ts";
import { configuredNamedSkipMappingIdentities, resolveNamedSkipMapping } from "./receipt.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BASE = "abc720e9bec812d9321349b931a40a9bcf8378cd";
const M_IDENTITIES = {
  "scripts/test-accounting/authority.ts": "57e5857eb8d52835fd9b70561b8e1119527e5397f74e0660e43d1defdfa6c26e",
  "scripts/test-accounting/node-reporter.ts": "08eceb3aba1fc9f5c997dab11919cb257a785d663fd4fbbf922ba7ce88e605fd",
};
const GOVERNED_ROUTES = new Set([
  "scripts/test-accounting/authority.ts",
  "scripts/mutation-falsification/run-groupme-pilot.ts",
]);
type ReadSource = (path: string) => string | undefined;
interface FrontDoor { file: string; owner: string; command: string; cwd: string }

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}
function packageScripts(source: string): Record<string, string> {
  const parsed: unknown = JSON.parse(source);
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  const scripts = (parsed as Record<string, unknown>).scripts;
  if (scripts === undefined) return {};
  assert.ok(scripts && typeof scripts === "object" && !Array.isArray(scripts));
  const result: Record<string, string> = {};
  for (const [name, command] of Object.entries(scripts)) {
    assert.equal(typeof command, "string");
    result[name] = command as string;
  }
  return result;
}
function scalar(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value) as string;
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value;
}

/** The repository uses ordinary block YAML steps. Reject unsupported run aliases/flow syntax,
 * rather than silently declaring an unparsed command exempt. This is not a shell interpreter. */
function workflowFrontDoors(file: string, source: string): FrontDoor[] {
  const lines = source.split("\n");
  const result: FrontDoor[] = [];
  let inJobs = false;
  let job = "";
  let step = "";
  let stepIndex = 0;
  let cwd = ".";
  let stepEntries: FrontDoor[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    assert.ok(!/^\s*defaults\s*:/.test(line), `${file}: workflow defaults must be explicit on each step for the command ratchet`);
    if (/^jobs:\s*$/.test(line)) inJobs = true;
    const jobMatch = inJobs && /^  ([\w-]+):\s*$/.exec(line);
    if (jobMatch) { job = jobMatch[1] ?? ""; stepIndex = 0; stepEntries = []; cwd = "."; }
    if (/^\s+-\s+(?:name|uses|id|run):/.test(line)) {
      stepIndex += 1; step = `step-${stepIndex}`; cwd = "."; stepEntries = [];
    }
    const name = /^\s+(?:-\s+)?name:\s*(.+)$/.exec(line);
    if (name) {
      step = scalar(name[1] ?? "");
      for (const entry of stepEntries) entry.owner = `${job}/${step}`;
    }
    const workingDirectory = /^\s+working-directory:\s*(.+)$/.exec(line);
    if (workingDirectory) {
      cwd = scalar(workingDirectory[1] ?? ".");
      for (const entry of stepEntries) entry.cwd = cwd;
    }
    const run = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (!run) {
      assert.ok(!/^[^#\n]*[{,]\s*["']?run["']?\s*:/.test(line), `${file}: unsupported flow-style run; use an ordinary step`);
      assert.ok(!/^\s*(?:-\s*)?["']?run["']?\s*:/.test(line), `${file}: unsupported run key syntax; use an ordinary step`);
      continue;
    }
    const indentation = (run[1] ?? "").length;
    let command = run[2] ?? "";
    assert.ok(!/^[*&]/.test(command), `${file}: run aliases must be explicit for the command ratchet`);
    const blockHeader = /^[|>][-+]?\s*(?:#.*)?$/.test(command);
    assert.ok(!/^[|>]/.test(command) || blockHeader, `${file}: unsupported run block header`);
    if (blockHeader) {
      const block: string[] = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1] ?? "";
        if (next.trim() && next.length - next.trimStart().length <= indentation) break;
        index += 1; block.push(next);
      }
      const nonempty = block.filter((entry) => entry.trim());
      const margin = Math.min(...nonempty.map((entry) => entry.length - entry.trimStart().length));
      command = block.map((entry) => entry.slice(Number.isFinite(margin) ? margin : 0)).join("\n").trimEnd();
    } else command = scalar(command);
    const entry = { file, owner: `${job}/${step}`, command, cwd };
    result.push(entry); stepEntries.push(entry);
  }
  return result;
}
function frontDoors(files: string[], read: ReadSource): FrontDoor[] {
  return files.flatMap((file) => {
    const source = read(file);
    assert.notEqual(source, undefined, `missing tracked front-door source: ${file}`);
    if (posix.basename(file) === "package.json") {
      return Object.entries(packageScripts(source ?? "")).map(([owner, command]) => ({ file, owner, command, cwd: posix.dirname(file) }));
    }
    return workflowFrontDoors(file, source ?? "");
  });
}
const identity = (entry: FrontDoor): string => JSON.stringify([entry.file, entry.owner, entry.command, entry.cwd]);
const RAW_TEST = /(?:^|[^\w-])--test(?:[^\w-]|$)|\b(?:vitest|jest|mocha|pytest)\b/;
const OPAQUE_PROCESS_WRAPPER = /\b(?:spawn(?:Sync)?|exec(?:Sync|File(?:Sync)?)?|fork|eval|Function)\s*\(|\bchild_process\b/;
const LOCAL_SCRIPT = /(?:^|[\s'"`(,])((?:\.{0,2}\/)?[\w./-]+\.(?:[cm]?[jt]s|sh|py))(?=$|[\s'"`),;])/g;
function localPath(cwd: string, path: string): string | undefined {
  const normalized = posix.normalize(posix.join(cwd, path));
  return normalized.startsWith("../") || posix.isAbsolute(normalized) ? undefined : normalized;
}

/** Bounded lexical dependency walk catches literal wrappers and npm aliases, including
 * compounds and cd/prefix forms. Computed filenames, generated scripts, remote actions and
 * arbitrary shell/JS evaluation are not statically certified by this check. New wrappers
 * with recognizable unresolved process/eval execution are conservatively refused; this
 * also refuses harmless process wrappers and requires an explicit reviewed public route. */
function reachesRawTest(command: string, cwd: string, read: ReadSource, seen = new Set<string>()): boolean {
  if (RAW_TEST.test(command)) return true;
  if (OPAQUE_PROCESS_WRAPPER.test(command)) return true;
  const key = JSON.stringify([cwd, command]);
  if (seen.has(key)) return false;
  seen.add(key);
  for (const part of command.split(/&&|\|\||[;\n]/)) {
    const changeDirectory = /^\s*cd\s+([\w./-]+)\s*$/.exec(part);
    if (changeDirectory) { cwd = localPath(cwd, changeDirectory[1] ?? "") ?? cwd; continue; }
    const words = (part.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g) ?? []).map(scalar);
    for (let index = 0; index < words.length; index += 1) {
      if (!["npm", "pnpm", "yarn"].includes(words[index] ?? "")) continue;
      let packageCwd: string | undefined = cwd;
      let alias: string | undefined;
      for (let argument = index + 1; argument < words.length; argument += 1) {
        const word = words[argument] ?? "";
        if (["--prefix", "--dir", "-C"].includes(word)) {
          packageCwd = localPath(cwd, words[argument + 1] ?? ""); argument += 1;
        } else if (word.startsWith("--prefix=")) packageCwd = localPath(cwd, word.slice(9));
        else if (word !== "run" && !word.startsWith("-") && alias === undefined) alias = word;
      }
      if (!packageCwd) continue;
      const manifest = read(posix.join(packageCwd, "package.json"));
      const nested = manifest && packageScripts(manifest)[alias ?? ""];
      if (nested && reachesRawTest(nested, packageCwd, read, seen)) return true;
    }
    for (const reference of part.matchAll(LOCAL_SCRIPT)) {
      const path = localPath(cwd, reference[1] ?? "");
      if (!path || GOVERNED_ROUTES.has(path)) continue;
      if (classifyTrackedPath(path).kind === "executable") return true;
      const source = read(path);
      // Spawned relative commands inherit cwd; static imports resolve by module directory.
      // Conservatively inspect both rather than assume every wrapper uses import semantics.
      if (source && (reachesRawTest(source, cwd, read, seen) || reachesRawTest(source, posix.dirname(path), read, seen))) return true;
      if (source && OPAQUE_PROCESS_WRAPPER.test(source)) return true;
    }
  }
  return false;
}
function violations(current: FrontDoor[], baseline: FrontDoor[], read: ReadSource): FrontDoor[] {
  // The exception binds the front-door tuple, not its historical implementation closure.
  // In particular, this port intentionally changes the existing package runner's bytes.
  const remaining = new Map<string, number>();
  for (const entry of baseline) remaining.set(identity(entry), (remaining.get(identity(entry)) ?? 0) + 1);
  return current.filter((entry) => {
    const key = identity(entry);
    const count = remaining.get(key) ?? 0;
    if (count > 0) { remaining.set(key, count - 1); return false; }
    return reachesRawTest(entry.command, entry.cwd, read);
  });
}
const isFrontDoorFile = (file: string): boolean => posix.basename(file) === "package.json" || /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file);

for (const [path, digest] of Object.entries(M_IDENTITIES)) {
  test(`${path} is byte-identical to M7acd4bac2`, () => {
    assert.equal(createHash("sha256").update(readFileSync(resolve(ROOT, path))).digest("hex"), digest);
  });
}
test("destination accounting production policy does not reintroduce pdpp instance exemptions or mappings", () => {
  const inventory = readFileSync(resolve(ROOT, "scripts/test-accounting/inventory.ts"), "utf8");
  const receipt = readFileSync(resolve(ROOT, "scripts/test-accounting/receipt.ts"), "utf8");
  assert.doesNotMatch(inventory, /EXECUTABLE_SMOKES|TEST_SCRATCH_CAPABILITY_ENVIRONMENT|SCRATCH_LIFECYCLE_ORACLE_PATHS|ownsScratchOracle/);
  assert.doesNotMatch(receipt, /POSTGRES_UNNAMED_SKIP_TEST_NAME|PROFILE_SCOPED_POSTGRES|riConfiguredNamedSkipMappingIdentities|["']ri-default["']/);
  assert.equal(classifyTrackedPath("packages/mcp-server/test/smoke-stdio.ts").kind, "helper-or-fixture");
  for (const extension of ["mjs", "cjs"]) assert.equal(classifyTrackedPath(`scripts/fixture.test.${extension}`).kind, "executable");
  assert.throws(() => configuredNamedSkipMappingIdentities("polyfill-connectors", "unreviewed"), /unrecognized/);
  assert.throws(() => configuredNamedSkipMappingIdentities("ri-default", "memory-default"), /unrecognized/);
  assert.equal(resolveNamedSkipMapping("PostgreSQL device-ingest conformance: derived repair and canonical records"), undefined);
});
test("canonical entrypoints grandfather only exact B file/owner/command/cwd tuples", () => {
  const files = git(["ls-files", "-z"]).split("\0").filter(isFrontDoorFile);
  const baseFiles = git(["ls-tree", "-r", "--name-only", BASE]).trim().split("\n").filter(isFrontDoorFile);
  const read: ReadSource = (path) => {
    const absolute = resolve(ROOT, path);
    return existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
  };
  const baseline = frontDoors(baseFiles, (path) => git(["show", `${BASE}:${path}`]));
  assert.deepEqual(violations(frontDoors(files, read), baseline, read), [], "new raw test front door: route through accounting authority");
});
test("the same canonical ratchet rejects direct, compound, alias and literal wrapper evasions", () => {
  const sources: Record<string, string> = {
    "package.json": JSON.stringify({ scripts: { hidden: "node scripts/wrapper.mjs", approved: "node --import tsx scripts/test-accounting/authority.ts --run --suite fixture" } }),
    "scripts/wrapper.mjs": 'import {spawnSync} from "node:child_process"; spawnSync("node", ["--test", "fixture.test.mjs"]);',
    "scripts/two-hop.mjs": 'import {spawnSync} from "node:child_process"; spawnSync("node", ["scripts/wrapper.mjs"]);',
    "scripts/computed.mjs": 'import {spawnSync} from "node:child_process"; spawnSync("node", ["--"+"test", "fixture.mjs"]);',
    "packages/fixture/package.json": JSON.stringify({ scripts: { test: "node --test fixture.test.mjs" } }),
  };
  const read: ReadSource = (path) => sources[path];
  const old = { file: "package.json", owner: "legacy", command: "node --test old.test.mjs", cwd: "." };
  assert.deepEqual(violations([old], [old], read), []);
  assert.deepEqual(violations([], [old], read), []);
  assert.equal(violations([old, old], [old], read).length, 1, "copying a grandfathered workflow step creates a new front door");
  for (const command of ["node --import tsx --test new.test.ts", "echo prepared && node --test x.test.mjs", "npm run hidden", "node scripts/wrapper.mjs", "node scripts/two-hop.mjs", "node scripts/computed.mjs", 'node -e "require(\'node:child_process\').spawnSync(\'node\',[\'--\'+\'test\',\'fixture.mjs\'])"', "node scripts/direct.test.mjs", "python scripts/direct.test.py", "npm --prefix packages/fixture test", "npm run test --prefix packages/fixture", "npm run --prefix packages/fixture test", "pnpm -C packages/fixture test", "cd packages/fixture && npm test", "node --import tsx scripts/test-accounting/authority.ts --run; node --test x.test.mjs"]) {
    assert.equal(violations([{ ...old, owner: "new", command }], [old], read).length, 1, command);
  }
  for (const field of ["owner", "file", "cwd"] as const) assert.equal(violations([{ ...old, [field]: "changed" }], [old], read).length, 1);
  assert.deepEqual(violations([{ ...old, owner: "approved", command: "npm run approved" }], [old], read), []);
});
test("workflow extraction keeps job/step and whole compound command, rejecting unsupported aliases", () => {
  const source = "jobs:\n  evidence:\n    steps:\n      - name: Check\n        working-directory: tools\n        run: |\n          echo ready\n          node --test fixture.test.mjs\n";
  const entries = workflowFrontDoors(".github/workflows/check.yml", source);
  assert.deepEqual(entries, [{ file: ".github/workflows/check.yml", owner: "evidence/Check", command: "echo ready\nnode --test fixture.test.mjs", cwd: "tools" }]);
  assert.equal(violations(entries, [], () => undefined).length, 1);
  const reordered = workflowFrontDoors(".github/workflows/check.yml", "jobs:\n  evidence:\n    steps:\n      - run: node wrapper.mjs\n        name: Check\n        working-directory: tools\n");
  assert.equal(reordered[0]?.cwd, "tools");
  assert.equal(reordered[0]?.owner, "evidence/Check");
  assert.equal(violations(reordered, [], (path) => path === "tools/wrapper.mjs" ? 'spawnSync("node", ["--test"]);' : undefined).length, 1);
  assert.throws(() => workflowFrontDoors("fixture.yml", "jobs:\n  check:\n    steps:\n      - run: *hidden\n"), /aliases/);
  assert.throws(() => workflowFrontDoors("fixture.yml", "jobs:\n  check:\n    steps: [{run: node --test x.mjs}]\n"), /flow-style/);
  assert.throws(() => workflowFrontDoors("fixture.yml", "defaults:\n  run:\n    working-directory: tools\n"), /defaults/);
  const commented = workflowFrontDoors("fixture.yml", "jobs:\n  check:\n    steps:\n      - run: | # literal block\n          node --test x.mjs\n");
  assert.equal(violations(commented, [], () => undefined).length, 1);
  const jobs = workflowFrontDoors("fixture.yml", "jobs:\n  first:\n    steps:\n      - name: Original\n        run: node --test x.mjs\n  second:\n    name: Other job\n    steps:\n      - run: echo done\n");
  assert.equal(jobs[0]?.owner, "first/Original", "later job metadata cannot rename an earlier step");
});

// Receipts and reviewed source must identify the branch head, not GitHub's synthetic merge commit.
test("all port workflow checkouts and artifact names bind the advertised PR head", () => {
  const source = readFileSync(resolve(ROOT, ".github/workflows/polyfill-connectors.yml"), "utf8");
  const checkouts = [...source.matchAll(/uses: actions\/checkout@[^\n]+\n([\s\S]*?)(?=\n      -|\n  [a-z]|$)/g)];
  assert.equal(checkouts.length, 4);
  for (const checkout of checkouts) assert.match(checkout[1] ?? "", /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  for (const name of ["accounted-suite", "evidence-tests"]) {
    assert.ok(source.includes("name: " + name + "-${{ github.event.pull_request.head.sha || github.sha }}"));
  }
});
