// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { build } from "esbuild";
await build({
  entryPoints: ["worker.mjs"],
  outfile: "dist/worker.mjs",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2024",
});
