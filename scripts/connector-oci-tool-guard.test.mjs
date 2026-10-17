// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";
import { assertNoUnbundledNativeDependency } from "./connector-oci-tool-guard.mjs";

const manifests = join(dirname(fileURLToPath(import.meta.url)), "..", "connectors");

describe("host-provisioned external tools", () => {
  function fixture(t, source = "process.env.FOO_BIN;") {
    const directory = mkdtempSync(join(tmpdir(), "connector-host-tool-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, "index.ts"), source);
    return directory;
  }

  function declaredTool(overrides = {}) {
    return {
      name: "foo", license: "ISC", purpose: "Export data",
      install_hint: "Install foo on the host",
      detect: { executable: "foo", executable_env_override: "FOO_BIN", args: ["version"], exit_code: 0 },
      ...overrides,
    };
  }

  function profile(...tools) {
    return { runtime_requirements: { external_tools: tools } };
  }

  test("accepts a declared host tool and repeated tokens", (t) => {
    assert.doesNotThrow(() => assertNoUnbundledNativeDependency(
      "fixture", profile(declaredTool()), fixture(t, "process.env.FOO_BIN; process.env.FOO_BIN;"),
    ));
  });

  test("refuses an undeclared token with actionable declaration details", (t) => {
    assert.throws(() => assertNoUnbundledNativeDependency("fixture", {}, fixture(t)),
      /fixture resolves \$FOO_BIN.*runtime_requirements\.external_tools.*detect\.executable_env_override.*FOO_BIN.*name.*license.*purpose.*install_hint/);
  });

  test("refuses a mismatched env override", (t) => {
    assert.throws(() => assertNoUnbundledNativeDependency(
      "fixture", profile(declaredTool({ detect: { executable_env_override: "OTHER_BIN" } })), fixture(t),
    ), /fixture resolves \$FOO_BIN/);
  });

  test("checks every distinct token", (t) => {
    assert.throws(() => assertNoUnbundledNativeDependency(
      "fixture", profile(declaredTool()), fixture(t, "process.env.FOO_BIN; process.env.BAR_BIN;"),
    ), /fixture resolves \$BAR_BIN/);
  });

  for (const field of ["name", "license", "purpose", "install_hint"]) {
    test(`refuses missing, blank or non-string ${field}`, (t) => {
      const directory = fixture(t);
      for (const value of [undefined, "", "  ", 42]) {
        assert.throws(() => assertNoUnbundledNativeDependency(
          "fixture", profile(declaredTool({ [field]: value })), directory,
        ), /fixture resolves \$FOO_BIN/);
      }
    });
  }

  test("refuses bundled tools under runtime_requirements", (t) => {
    assert.throws(() => assertNoUnbundledNativeDependency(
      "fixture", profile(declaredTool({ provisioning: "bundled" })), fixture(t, ""),
    ), /declares a bundled external tool/);
  });

  test("does not accept a declaration at the obsolete top level", (t) => {
    assert.throws(() => assertNoUnbundledNativeDependency(
      "fixture", { external_tools: [declaredTool()] }, fixture(t),
    ), /fixture resolves \$FOO_BIN/);
  });

  test("retains the module-relative asset refusal", (t) => {
    assert.throws(() => assertNoUnbundledNativeDependency(
      "fixture", profile(declaredTool()),
      fixture(t, 'process.env.FOO_BIN; new URL("../asset.toml", import.meta.url);'),
    ), /escapes the install root/);
  });

  test("slack's real declaration passes the guard", () => {
    const directory = join(manifests, "slack");
    const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
    assert.ok(readFileSync(join(directory, "index.ts"), "utf8").includes("SLACKDUMP_BIN"));
    assert.doesNotThrow(() => assertNoUnbundledNativeDependency("slack", manifest, directory));
  });

  for (const [connector, token] of [["signal", "SIGTOP_BIN"], ["google_messages", "GMCLI_BIN"]]) {
    test(`${connector}'s real declaration still refuses ${token}`, () => {
      const directory = join(manifests, connector);
      const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
      assert.throws(() => assertNoUnbundledNativeDependency(connector, manifest, directory),
        (error) => error.message.startsWith(`${connector} resolves \$${token}`));
    });
  }
});
