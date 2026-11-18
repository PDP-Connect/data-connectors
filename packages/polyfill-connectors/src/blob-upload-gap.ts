// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { EmittedMessage } from "@pdpp/connector-protocol/connector-runtime-protocol";
import { connectorDiagnostic } from "./connector-diagnostic.ts";
import { runtimeBlobUploadAvailable } from "./reference-blob-uploader.ts";

export const BLOB_UPLOAD_UNAVAILABLE_REASON = "blob_upload_unavailable";

/**
 * Build the once-per-run reporter a connector calls before it would upload an
 * attachment. When the runtime gave no blob upload credential the first call
 * emits one SKIP_RESULT (and one run-log line) saying attachment bytes were
 * not uploaded; later calls, and every call when the credential is present,
 * do nothing. SKIP_RESULT is the channel connectors already use for a
 * capability that is unavailable this run, and it rides alongside the records
 * that still emit, as signal's `no_attachments_exported` does.
 *
 * Carries no environment values: only the variable names the runtime must set.
 */
export function makeBlobUploadGapReporter(args: {
  connector: string;
  emit: (msg: EmittedMessage) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  stream: string;
}): () => Promise<void> {
  let reported = false;
  return async () => {
    if (reported || runtimeBlobUploadAvailable(args.env ?? process.env)) {
      return;
    }
    // The report is used up only once the SKIP_RESULT is out. A failed emit
    // must not fail the attachment that triggered it, so the next attachment
    // tries again.
    try {
      await args.emit({
        type: "SKIP_RESULT",
        stream: args.stream,
        reason: BLOB_UPLOAD_UNAVAILABLE_REASON,
        message:
          "Attachment bytes were not uploaded: the runtime provided no blob upload credential " +
          "(PDPP_RS_URL and PDPP_BLOB_UPLOAD_TOKEN). Attachment records were emitted without their files.",
        recovery_hint: { action: "retry_by_runtime", retryable: true },
      });
    } catch {
      return;
    }
    reported = true;
    connectorDiagnostic(args.connector, BLOB_UPLOAD_UNAVAILABLE_REASON, {
      stream: args.stream,
    });
  };
}
