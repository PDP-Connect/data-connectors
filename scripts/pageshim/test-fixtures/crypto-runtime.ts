// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from "node:crypto";
import { createHash as bareHash } from "crypto";
import { unportedHash } from "./crypto-unported.ts";
import { recordFingerprint } from "../../../packages/polyfill-connectors/src/fingerprint-cursor.ts";

(globalThis as any).__pageshimMain = async () => {
  (globalThis as any).hashResult=recordFingerprint({z:2,a:"世界",fetched_at:"ignored"},["fetched_at"]);
  (globalThis as any).binaryHashResult=createHash("sha256").update(new Uint8Array([0,128,255])).digest("hex");
  try { bareHash("sha1"); } catch(error) {
    (globalThis as any).bareCrypto=String(error).includes("pageshim stub:");
  }
  try { unportedHash(); } catch(error) {
    (globalThis as any).unportedCrypto=String(error).includes("pageshim stub:");
  }
  try { randomBytes(4); } catch(error) {
    (globalThis as any).unsupportedCrypto=String(error).includes("pageshim stub:");
  }
};
