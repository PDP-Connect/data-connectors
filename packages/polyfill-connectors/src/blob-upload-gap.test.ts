// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { EmittedMessage } from "@pdpp/connector-protocol/connector-runtime-protocol";
import { BLOB_UPLOAD_UNAVAILABLE_REASON, makeBlobUploadGapReporter } from "./blob-upload-gap.ts";
import { setConnectorDiagnosticSink } from "./connector-diagnostic.ts";

function harness(env: NodeJS.ProcessEnv) {
  const emitted: EmittedMessage[] = [];
  const lines: string[] = [];
  setConnectorDiagnosticSink((line) => lines.push(line));
  const report = makeBlobUploadGapReporter({
    connector: "demo",
    emit: (msg) => {
      emitted.push(msg);
      return Promise.resolve();
    },
    env,
    stream: "attachments",
  });
  return { emitted, lines, report };
}

test("blob upload gap: emits one SKIP_RESULT however many times it is called", async () => {
  const { emitted, lines, report } = harness({ PDPP_RS_URL: "http://rs.local" });
  try {
    await report();
    await report();
    await report();
    assert.equal(emitted.length, 1);
    assert.equal(lines.length, 1);
    const [msg] = emitted;
    assert.equal(msg?.type, "SKIP_RESULT");
    if (msg?.type === "SKIP_RESULT") {
      assert.equal(msg.reason, BLOB_UPLOAD_UNAVAILABLE_REASON);
      assert.equal(msg.stream, "attachments");
    }
  } finally {
    setConnectorDiagnosticSink(undefined);
  }
});

test("blob upload gap: a runtime that sets only the retired owner variable is reported, and no value leaks", async () => {
  const { emitted, lines, report } = harness({
    PDPP_OWNER_TOKEN: "legacy-owner-secret",
    PDPP_RS_URL: "http://rs.local",
  });
  try {
    await report();
    assert.equal(emitted.length, 1);
    assert.ok(!JSON.stringify(emitted).includes("legacy-owner-secret"));
    assert.ok(!lines.join("\n").includes("legacy-owner-secret"));
  } finally {
    setConnectorDiagnosticSink(undefined);
  }
});

test("blob upload gap: stays silent when the runtime provided the upload credential", async () => {
  const { emitted, lines, report } = harness({
    PDPP_BLOB_UPLOAD_TOKEN: "run-scoped",
    PDPP_RS_URL: "http://rs.local",
  });
  try {
    await report();
    assert.equal(emitted.length, 0);
    assert.equal(lines.length, 0);
  } finally {
    setConnectorDiagnosticSink(undefined);
  }
});
