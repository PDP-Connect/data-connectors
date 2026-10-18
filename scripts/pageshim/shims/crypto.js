// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Synchronous FIPS 180-4 SHA-1/SHA-256 for PageShim's audited createHash
// consumers. Only UTF-8 strings / Uint8Array input and hex output are
// supported. No Node globals, WebCrypto promises, or input-sized buffering.
const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
const rotateRight = (x, n) => (x >>> n) | (x << (32 - n));
const rotateLeft = (x, n) => (x << n) | (x >>> (32 - n));

export function createHash(algorithm) {
  if (algorithm !== "sha1" && algorithm !== "sha256")
    throw new Error(`pageshim: createHash(${algorithm}) is not available`);
  const sha1 = algorithm === "sha1";
  const state = new Uint32Array(sha1
    ? [0x67452301,0xefcdab89,0x98badcfe,0x10325476,0xc3d2e1f0]
    : [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const words = new Uint32Array(sha1 ? 80 : 64);
  const tail = new Uint8Array(64);
  let used = 0;
  let length = 0;
  let finalized = false;
  function compress(bytes, offset) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 64);
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(i * 4);
    if (sha1) {
      for (let i = 16; i < 80; i++)
        words[i] = rotateLeft(words[i-3] ^ words[i-8] ^ words[i-14] ^ words[i-16], 1);
      let [a,b,c,d,e] = state;
      for (let i = 0; i < 80; i++) {
        const f = i < 20 ? ((b & c) | (~b & d)) : i < 40 ? (b ^ c ^ d) :
          i < 60 ? ((b & c) | (b & d) | (c & d)) : (b ^ c ^ d);
        const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
        const next = (rotateLeft(a, 5) + f + e + k + words[i]) >>> 0;
        e=d; d=c; c=rotateLeft(b,30); b=a; a=next;
      }
      state[0]+=a; state[1]+=b; state[2]+=c; state[3]+=d; state[4]+=e;
    } else {
      for (let i=16; i<64; i++) {
        const x=words[i-15], y=words[i-2];
        words[i]=(words[i-16]+(rotateRight(x,7)^rotateRight(x,18)^(x>>>3))+
          words[i-7]+(rotateRight(y,17)^rotateRight(y,19)^(y>>>10)))>>>0;
      }
      let [a,b,c,d,e,f,g,h]=state;
      for (let i=0; i<64; i++) {
        const t1=(h+(rotateRight(e,6)^rotateRight(e,11)^rotateRight(e,25))+
          ((e&f)^(~e&g))+K[i]+words[i])>>>0;
        const t2=((rotateRight(a,2)^rotateRight(a,13)^rotateRight(a,22))+
          ((a&b)^(a&c)^(b&c)))>>>0;
        h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
      }
      state[0]+=a; state[1]+=b; state[2]+=c; state[3]+=d;
      state[4]+=e; state[5]+=f; state[6]+=g; state[7]+=h;
    }
  }
  return {
    update(data, encoding = "utf8") {
      if (finalized) throw new Error("Digest already called");
      if (typeof data === "string") {
        if (encoding !== "utf8" && encoding !== "utf-8")
          throw new Error(`pageshim: update encoding ${encoding} is not available`);
        data = new TextEncoder().encode(data);
      } else if (!(data instanceof Uint8Array)) {
        throw new TypeError("pageshim: update requires a string or Uint8Array");
      }
      if (!Number.isSafeInteger(length + data.length)) throw new RangeError("Hash input too large");
      length += data.length;
      let offset=0;
      if (used) {
        const count=Math.min(64-used,data.length);
        tail.set(data.subarray(0,count),used); used+=count; offset+=count;
        if (used===64) { compress(tail,0); used=0; }
      }
      while (offset+64<=data.length) { compress(data,offset); offset+=64; }
      if (offset<data.length) { tail.set(data.subarray(offset),0); used=data.length-offset; }
      return this;
    },
    digest(encoding) {
      if (finalized) throw new Error("Digest already called");
      if (encoding !== "hex") throw new Error(`pageshim: digest(${encoding}) is not available`);
      finalized=true;
      tail[used++]=0x80;
      tail.fill(0,used);
      if (used>56) { compress(tail,0); tail.fill(0); }
      const view=new DataView(tail.buffer);
      view.setUint32(56,Math.floor(length/0x20000000));
      view.setUint32(60,(length*8)>>>0);
      compress(tail,0);
      return [...state].map(x=>x.toString(16).padStart(8,"0")).join("");
    },
  };
}
