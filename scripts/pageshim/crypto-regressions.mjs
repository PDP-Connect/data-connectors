// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash as nodeHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { createHash } from "./shims/crypto.js";
import { isPageShimCapable } from "./capabilities.mjs";

export function assertHashParity() {
  const binary = Uint8Array.from({ length: 257 }, (_, i) => i);
  const large = Uint8Array.from({ length: 1024 * 1024 + 17 }, (_, i) => (i * 37) & 255);
  const vectors = [
    [], [""], ["abc"], ["héllø 世界 🦊 \ud800"], [binary],
    [binary.subarray(7, 220)], [large], ["a", "b", "", "c"],
    ["prefix", binary.subarray(3, 97), "世界", large.subarray(63)],
    ...[55,56,63,64,65,119,120,127,128,129].map(n => [new Uint8Array(n).fill(97)]),
    Array.from({ length: 513 }, (_, i) => Uint8Array.of(i & 255)),
  ];
  for (const algorithm of ["sha1", "sha256"]) {
    for (const chunks of vectors) {
      const expected=nodeHash(algorithm), actual=createHash(algorithm);
      for (const chunk of chunks) { expected.update(chunk); assert.equal(actual.update(chunk),actual); }
      assert.equal(actual.digest("hex"), expected.digest("hex"), algorithm);
      assert.throws(() => actual.update("after"), /Digest already called/);
      assert.throws(() => actual.digest("hex"), /Digest already called/);
    }
    const data=Uint8Array.of(1,2,3), hash=createHash(algorithm).update(data);
    data.fill(255);
    assert.equal(hash.digest("hex"),nodeHash(algorithm).update(Uint8Array.of(1,2,3)).digest("hex"));
    assert.equal(createHash(algorithm).update("é","utf-8").digest("hex"),nodeHash(algorithm).update("é").digest("hex"));
    assert.throws(() => createHash(algorithm).update("aa","hex"), /not available/);
    assert.throws(() => createHash(algorithm).update({}), /Uint8Array/);
    assert.throws(() => createHash(algorithm).digest("base64"), /not available/);
  }
  assert.throws(() => createHash("md5"), /not available/);
}

export function assertPageOnlyAdmission() {
  const make = (browser, network) => ({ runtime_requirements: { bindings: {
    browser, ...(network === undefined ? {} : { network }),
  }}});
  const browser={required:true,features:["page_script_evaluation","page_navigation"]};
  for (const network of [undefined,{required:false},{required:false,features:["same_origin_page_fetch"]}])
    assert.equal(isPageShimCapable(make(browser,network)),true);
  for (const network of [{required:true},{required:true,features:[]},
    {required:true,features:["unknown"]},{required:false,features:["unknown"]}])
    assert.equal(isPageShimCapable(make(browser,network)),false);
  for (const b of [{required:false,features:["page_script_evaluation"]},
    {required:true,features:["page_navigation"]},{required:true,features:["page_script_evaluation","unknown"]},
    {required:true,features:[]}])
    assert.equal(isPageShimCapable(make(b)),false);
}

export async function assertFingerprintBundle(buildPageshim, outfile) {
  await buildPageshim({
    connector:"chatgpt", outfile,
    entryPoint:fileURLToPath(new URL("./test-fixtures/crypto-runtime.ts",import.meta.url)),
  });
  const context={page:{},process:{env:{}},TextEncoder,Uint8Array};
  await runInNewContext(readFileSync(outfile,"utf8"),context);
  assert.equal(context.hashResult, nodeHash("sha1").update('{"a":"世界","z":2}').digest("hex"));
  assert.equal(context.binaryHashResult,nodeHash("sha256").update(Uint8Array.of(0,128,255)).digest("hex"));
  assert.equal(context.unsupportedCrypto,true);
  assert.equal(context.bareCrypto,true);
  assert.equal(context.unportedCrypto,true);
}
