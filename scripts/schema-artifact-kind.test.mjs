import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("schema health check accepts PDPP manifest-backed stream schemas", () => {
  const stdout = execFileSync(
    process.execPath,
    ["scripts/schema-health-check.mjs", "--base-ref", "origin/main", "--json"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const report = JSON.parse(stdout);
  const pdppScopes = report.scopes.filter((entry) => entry.connector === "github-pdpp");

  assert.equal(pdppScopes.length, 7);
  assert.ok(pdppScopes.every((entry) => entry.schemaFileExists));
  assert.ok(pdppScopes.every((entry) => entry.consistent));
  assert.deepEqual(
    pdppScopes.map((entry) => entry.scope).sort(),
    [
      "github-pdpp:gists",
      "github-pdpp:issues",
      "github-pdpp:pull_requests",
      "github-pdpp:repositories",
      "github-pdpp:starred",
      "github-pdpp:user",
      "github-pdpp:user_stats",
    ],
  );
});

test("additive schema check includes registry entries without legacy metadata files", () => {
  const stdout = execFileSync(process.execPath, ["scripts/check-additive-schemas.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, BASE_REF: "origin/main" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.match(stdout, /^Schemas additive: \d+ schema\(s\) checked\.\n$/);
});
