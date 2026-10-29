// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { clientConfig, declareReady } from "../declare-catalog-ready.mjs";
const packageDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryDir = resolve(packageDir, "../..");
const env = {
  CATALOG_PUBLISHER_URL: "https://publisher.example/ready",
  CATALOG_PUBLISHER_AUDIENCE: "catalog-publisher-production",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://vstoken.actions.githubusercontent.com/request",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "test-actions-request-token",
};
const record = {
  schema: "pdpp.catalog.ready.v1",
  repository: "ghcr.io/pdp-connect/connector-catalog",
  digest: `sha256:${"a".repeat(64)}`,
  source_commit: "b".repeat(40),
  generated_at: "2026-10-29T12:00:00.000Z",
};
const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJ0ZXN0Ijp0cnVlfQ.c2lnbmF0dXJl";

test("Actions client refuses missing/invalid secret/config before any HTTP", async () => {
  assert.ok(clientConfig(env));
  for (const field of Object.keys(env)) {
    assert.throws(() => clientConfig({ ...env, [field]: undefined }), field);
    assert.throws(() => clientConfig({ ...env, [field]: "" }), field);
  }
  for (const bad of [
    { CATALOG_PUBLISHER_URL: "http://publisher.example/ready" },
    { CATALOG_PUBLISHER_URL: "https://user:password@publisher.example/ready" },
    { CATALOG_PUBLISHER_URL: "https://publisher.example/ready?q=secret" },
    { CATALOG_PUBLISHER_AUDIENCE: "SET_AUDIENCE" },
    { ACTIONS_ID_TOKEN_REQUEST_URL: "https://actions.githubusercontent.com.evil.example/" },
    { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "invalid\nsecret" },
  ])
    assert.throws(() => clientConfig({ ...env, ...bad }));
  let called = false;
  await assert.rejects(
    declareReady(record, { ...env, ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined }, () => {
      called = true;
    }),
  );
  assert.equal(called, false);
});

test("token errors, redirects, unavailable publisher and invalid success bodies fail visibly", async () => {
  for (const status of [302, 401, 503]) {
    await assert.rejects(
      declareReady(
        record,
        env,
        async () => new Response("", { status }),
        async () => {},
      ),
      /Actions OIDC HTTP/,
    );
  }
  for (const value of [undefined, "invalid", "x".repeat(20_000)])
    await assert.rejects(
      declareReady(record, env, async () => Response.json({ value })),
      /OIDC response/,
    );
  for (const status of [301, 401, 409, 500, 503]) {
    let calls = 0;
    await assert.rejects(
      declareReady(
        record,
        env,
        async () => (++calls === 1 ? Response.json({ value: jwt }) : new Response("", { status })),
        async () => {},
      ),
      /publisher declaration HTTP/,
    );
    assert.equal(calls, status >= 500 ? 4 : 2);
  }
  await assert.rejects(
    declareReady(record, env, async (url) =>
      new URL(url).hostname.startsWith("vstoken")
        ? Response.json({ value: jwt })
        : Response.json({ accepted: false }, { status: 202 }),
    ),
    /acknowledgement/,
  );
  await assert.rejects(
    declareReady(record, env, async () => new Response("x".repeat(40_000))),
    /response too large/,
  );
});

test("repository workflow keeps catalog publication and recovery policy", async () => {
  const workflow = await readFile(
    resolve(repositoryDir, ".github/workflows/publish-polyfill-connectors.yml"),
    "utf8",
  );
  const catalog = workflow.slice(workflow.indexOf("\n  catalog:"));
  assert.match(catalog, /needs\.publish\.result\s*==\s*'failure'/);
  assert.match(catalog, /inputs\.catalog-only/);
  assert.match(catalog, /inputs\.recover-latest/);
  assert.match(
    catalog,
    /name: Publish and verify the connector catalog\n\s+if: \$\{\{ github\.ref == 'refs\/heads\/main' && !inputs\.dry-run && !inputs\.recover-latest \}\}/,
  );
  assert.match(
    catalog,
    /name: Recover the ready declaration for the verified latest catalog\n\s+if: \$\{\{ github\.ref == 'refs\/heads\/main' && !inputs\.dry-run && inputs\.recover-latest \}\}/,
  );
  assert.match(catalog, /run: bash scripts\/websub-publisher\/recover-catalog-ready\.sh/);

  const sign = catalog.indexOf("cosign sign --yes");
  const verify = catalog.indexOf("for bundle_format in true false; do", sign);
  const tag = catalog.indexOf("oras tag ", verify);
  const declare = catalog.indexOf("declare-catalog-ready.mjs", tag);
  const preflight = catalog.indexOf("name: Check catalog publisher configuration");
  assert.ok(
    preflight >= 0 && preflight < sign && catalog.includes("declare-catalog-ready.mjs --check-config"),
  );
  assert.ok(
    sign >= 0 && verify > sign && tag > verify && declare > tag,
    "catalog readiness is declared after signing, verification, and tagging",
  );
});

test("recovery shell uses exact verified digest; signature/lookup/recheck failures stop declaration", async (t) => {
  const dir = resolve(packageDir, ".runtime/recovery-test");
  await rm(dir, { recursive: true, force: true });
  await mkdir(`${dir}/scripts`, { recursive: true });
  await mkdir(`${dir}/bin`, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(`${dir}/scripts/registry-command.sh`, "# test CLI contract; no network\n");
  await writeFile(
    `${dir}/catalog.json`,
    JSON.stringify({ source_commit: record.source_commit, generated_at: record.generated_at }),
  );
  await writeFile(
    `${dir}/scripts/lookup-manifest.mjs`,
    `
    import { appendFileSync, existsSync } from 'node:fs';
    const marker = process.env.TEST_ROOT + '/looked-up';
    const outcome = process.env.TEST_LOOKUP_FAIL === '1' ? 'unknown' : 'present';
    const digest = process.env.TEST_RECHECK_MOVE === '1' && existsSync(marker) ? 'sha256:' + 'c'.repeat(64) : 'sha256:' + 'a'.repeat(64);
    appendFileSync(marker, '1');
    console.log(JSON.stringify({ outcome, digest }));
  `,
  );
  const nodeStub = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args[0]?.endsWith('/declare-catalog-ready.mjs')) {
  if (args[1] !== '--digest' || args[3] !== '--catalog') process.exit(2);
  const c = JSON.parse(readFileSync(args[4], 'utf8'));
  appendFileSync(process.env.TEST_ROOT + '/declarations', JSON.stringify({digest: args[2], ...c}) + '\\n');
} else { const p = spawnSync(process.env.REAL_NODE, args, {stdio: 'inherit'}); process.exit(p.status ?? 1); }
`;
  const orasStub = `#!/usr/bin/env node
import {appendFileSync, copyFileSync, mkdirSync} from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.TEST_ROOT + '/commands', JSON.stringify(['oras', ...args]) + '\\n');
if (args[0] === 'pull') { const out = args[args.indexOf('--output') + 1]; mkdirSync(out, {recursive:true}); copyFileSync(process.env.TEST_ROOT + '/catalog.json', out + '/catalog.json'); }
else if (args[0] !== 'login') process.exit(3);
`;
  const cosignStub = `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';
appendFileSync(process.env.TEST_ROOT + '/commands', JSON.stringify(['cosign', ...process.argv.slice(2)]) + '\\n');
if (process.env.TEST_SIGNATURE_FAIL === '1') process.exit(1);
`;
  // CLI shims use the pinned Node and the fixture's module package.
  for (const [name, source] of [
    ["node", nodeStub],
    ["oras", orasStub],
    ["cosign", cosignStub],
  ]) {
    await writeFile(`${dir}/bin/${name}`, source.replace("#!/usr/bin/env node", `#!${process.execPath}`), {
      mode: 0o755,
    });
  }
  await writeFile(`${dir}/package.json`, '{"type":"module"}');
  const script = resolve(packageDir, "recover-catalog-ready.sh");
  const run = async (overrides) => {
    for (const name of ["commands", "declarations", "looked-up"]) await rm(`${dir}/${name}`, { force: true });
    return spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...env,
        GITHUB_WORKSPACE: dir,
        RUNNER_TEMP: `${dir}/temp`,
        GH_TOKEN: "test-gh-token",
        GITHUB_ACTOR: "test-actor",
        TEST_ROOT: dir,
        REAL_NODE: process.execPath,
        PATH: `${dir}/bin:${process.env.PATH}`,
        ...overrides,
      },
    });
  };
  const success = await run({});
  assert.equal(success.status, 0, success.stderr);
  const commands = (await readFile(`${dir}/commands`, "utf8")).trim().split("\n").map(JSON.parse);
  const verifications = commands.filter((c) => c[0] === "cosign");
  assert.equal(verifications.length, 2);
  for (const cmd of verifications) {
    assert.ok(cmd.includes(`${record.repository}@${record.digest}`));
    assert.equal(
      cmd[cmd.indexOf("--certificate-identity") + 1],
      "https://github.com/PDP-Connect/data-connectors/.github/workflows/publish-polyfill-connectors.yml@refs/heads/main",
    );
  }
  assert.equal(
    commands.findIndex((c) => c[1] === "pull") > commands.findIndex((c) => c[0] === "cosign"),
    true,
  );
  assert.deepEqual(JSON.parse((await readFile(`${dir}/declarations`, "utf8")).trim()), {
    digest: record.digest,
    source_commit: record.source_commit,
    generated_at: record.generated_at,
  });
  const missingPublisherConfig = await run({ CATALOG_PUBLISHER_URL: "", CATALOG_PUBLISHER_AUDIENCE: "" });
  assert.notEqual(missingPublisherConfig.status, 0);
  await assert.rejects(readFile(`${dir}/commands`), { code: "ENOENT" });
  await assert.rejects(readFile(`${dir}/declarations`), { code: "ENOENT" });
  for (const failure of [
    { TEST_SIGNATURE_FAIL: "1" },
    { TEST_LOOKUP_FAIL: "1" },
    { TEST_RECHECK_MOVE: "1" },
  ]) {
    const result = await run(failure);
    assert.notEqual(result.status, 0, JSON.stringify(failure));
    await assert.rejects(readFile(`${dir}/declarations`), { code: "ENOENT" });
  }
});
