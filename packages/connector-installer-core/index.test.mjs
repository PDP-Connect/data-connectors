import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SIGSTORE_CERTIFICATE_IDENTITY,
  TRANSITIONAL_ARTIFACT_CERTIFICATE_IDENTITIES,
  verifyRemoteSignature,
} from "./index.mjs";

async function withSigstoreBundle(fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({}));
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function signature() {
  return {
    type: "sigstoreBundle",
    bundleUrl: "https://example.test/artifact.tgz.sigstore.json",
  };
}

test("artifact verification accepts the second transitional certificate identity", async () => {
  await withSigstoreBundle(async () => {
    const attempted = [];

    await verifyRemoteSignature({
      payloadBuffer: Buffer.from("artifact"),
      subjectLabel: "Connector artifact example@1.0.0",
      subjectUrl: "https://example.test/artifact.tgz",
      signature: signature(),
      certificateIdentities: TRANSITIONAL_ARTIFACT_CERTIFICATE_IDENTITIES,
      verifyBundle: async (_bundle, _payload, options) => {
        attempted.push(options.certificateIdentityURI);
        if (
          options.certificateIdentityURI ===
          TRANSITIONAL_ARTIFACT_CERTIFICATE_IDENTITIES[1]
        ) {
          return;
        }
        throw new Error("certificate identity does not match PDP-Connect");
      },
    });

    assert.deepEqual(attempted, TRANSITIONAL_ARTIFACT_CERTIFICATE_IDENTITIES);
  });
});

test("artifact verification reports every attempted transitional certificate identity", async () => {
  await withSigstoreBundle(async () => {
    await assert.rejects(
      verifyRemoteSignature({
        payloadBuffer: Buffer.from("artifact"),
        subjectLabel: "Connector artifact example@1.0.0",
        subjectUrl: "https://example.test/artifact.tgz",
        signature: signature(),
        certificateIdentities: TRANSITIONAL_ARTIFACT_CERTIFICATE_IDENTITIES,
        verifyBundle: async () => {
          throw new Error("certificate identity does not match");
        },
      }),
      (error) => {
        assert.match(error.message, /Connector artifact example@1\.0\.0 signature verification failed:/);
        for (const identity of TRANSITIONAL_ARTIFACT_CERTIFICATE_IDENTITIES) {
          assert.match(error.message, new RegExp(identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        }
        return true;
      }
    );
  });
});

test("index verification remains strict to the PDP-Connect certificate identity", async () => {
  await withSigstoreBundle(async () => {
    const attempted = [];

    await verifyRemoteSignature({
      payloadBuffer: Buffer.from("index"),
      subjectLabel: "Connector index",
      subjectUrl: "https://example.test/connector-index.json",
      signature: signature(),
      verifyBundle: async (_bundle, _payload, options) => {
        attempted.push(options.certificateIdentityURI);
      },
    });

    assert.deepEqual(attempted, [DEFAULT_SIGSTORE_CERTIFICATE_IDENTITY]);
  });
});
