import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "create-connector.sh");
const temporaryRoot = join(homedir(), ".tmp");
mkdirSync(temporaryRoot, { recursive: true });

test("legacy creator rejects an unmarked request", () => {
  const result = spawnSync(
    "bash",
    [script, "execution-path-test", "--skip-session"],
    {
      cwd: temporaryRoot,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 2);
  assert.match(result.stdout, /without --legacy-exception/);
});

test("legacy creator resolves agent, prompt, and formatter paths from its working directory", () => {
  const fixtureRoot = mkdtempSync(
    join(temporaryRoot, "create-connector-path-test-"),
  );
  const binDirectory = join(fixtureRoot, "bin");
  const captureDirectory = join(fixtureRoot, "capture");
  mkdirSync(binDirectory);
  mkdirSync(captureDirectory);
  const fakeClaude = join(binDirectory, "claude");
  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const capture = process.env.CREATE_CONNECTOR_CAPTURE_DIR;
writeFileSync(join(capture, "cwd"), process.cwd());
writeFileSync(join(capture, "args.json"), JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ type: "result", result: "fixture complete" }) + "\\n");
`,
  );
  chmodSync(fakeClaude, 0o755);

  try {
    const platform = "executionpathtest";
    const result = spawnSync(
      "bash",
      [script, "--legacy-exception", platform, "--skip-session"],
      {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          CREATE_CONNECTOR_CAPTURE_DIR: captureDirectory,
          PATH: `${binDirectory}:${process.env.PATH}`,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(join(captureDirectory, "cwd"), "utf8"),
      root,
    );
    const args = JSON.parse(
      readFileSync(join(captureDirectory, "args.json"), "utf8"),
    );
    const promptIndex = args.indexOf("-p") + 1;
    assert.ok(promptIndex > 0, "Claude invocation must include a prompt");
    const prompt = args[promptIndex];
    assert.match(
      prompt,
      new RegExp(`working directory is ${escapeRegExp(root)}`),
    );
    assert.match(
      prompt,
      new RegExp(
        `${escapeRegExp(root)}/connectors/executionpathtest/executionpathtest-playwright\\.js`,
      ),
    );
    assert.match(
      prompt,
      new RegExp(
        `${escapeRegExp(root)}/\\.claude/skills/auto-create-connector/SKILL\\.md`,
      ),
    );
    assert.doesNotMatch(prompt, /\.\.\/connectors/);
    assert.match(result.stdout, /fixture complete/);
    assert.equal(existsSync(join(root, "scripts", "format-stream.cjs")), true);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("the documented scaffold command runs from the repository root", () => {
  const fixtureRoot = mkdtempSync(join(temporaryRoot, "scaffold-path-test-"));
  const platform = "documentedpathtest";

  try {
    const result = spawnSync(
      "node",
      [
        "skills/pdp-connect/scripts/scaffold.cjs",
        "--legacy-exception",
        platform,
        platform,
        fixtureRoot,
      ],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      existsSync(join(fixtureRoot, platform, `${platform}-playwright.js`)),
      true,
    );
    assert.equal(
      existsSync(join(fixtureRoot, platform, `${platform}-playwright.json`)),
      true,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
