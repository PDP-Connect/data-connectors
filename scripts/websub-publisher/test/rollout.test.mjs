// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../declare-catalog-ready.mjs";

const packageDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("an unconfigured publisher leaves catalog release intact, while partial configuration fails", async (t) => {
  const runtimeDir = resolve(packageDir, ".runtime");
  await mkdir(runtimeDir, { recursive: true });
  const directory = await mkdtemp(resolve(runtimeDir, "rollout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalog = resolve(directory, "catalog.json");
  await writeFile(
    catalog,
    JSON.stringify({ source_commit: "a".repeat(40), generated_at: "2026-10-29T12:00:00.000Z" }),
  );
  const args = ["--digest", `sha256:${"b".repeat(64)}`, "--catalog", catalog];
  await assert.doesNotReject(main(args, {}));
  await assert.rejects(main(args, { CATALOG_PUBLISHER_URL: "https://publisher.example/ready" }));
});
