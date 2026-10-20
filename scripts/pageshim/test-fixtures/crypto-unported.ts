// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// An unaudited importer must keep throwing, like Desktop-only helpers.
import { createHash } from "node:crypto";
export const unportedHash = () => createHash("sha1").update("unported").digest("hex");
