// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function compatibilityGate({ changesResult, relevant, compatibilityResult }) {
  if (changesResult !== "success") {
    return false;
  }
  if (relevant === "true") {
    return compatibilityResult === "success";
  }
  if (relevant === "false") {
    return compatibilityResult === "skipped";
  }
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const accepted = compatibilityGate({
    changesResult: process.env.CHANGES_RESULT,
    relevant: process.env.RELEVANT,
    compatibilityResult: process.env.COMPATIBILITY_RESULT,
  });
  if (!accepted) {
    process.stderr.write("scenario compatibility gate rejected job results\n");
    process.exitCode = 1;
  }
}
