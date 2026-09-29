// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Bundle-local `Buffer`, injected only for connectors that need it. It has
// only what they call: Buffer.from(string, "utf8") for a byte length and a
// hash input, and Buffer.byteLength(string, "utf8"). Any other member reads as undefined and is recorded.
globalThis.__pdppStubHits ??= [];
const hits = globalThis.__pdppStubHits;
const impl = {
	from(value, encoding = "utf8") {
		if (typeof value !== "string" || !/^utf-?8$/i.test(encoding)) {
			hits.push("Buffer.from(non-utf8)");
			throw new Error("pageshim: Buffer.from supports utf8 strings only");
		}
		return new TextEncoder().encode(value);
	},
	byteLength(value, encoding = "utf8") {
		if (typeof value !== "string" || !/^utf-?8$/i.test(encoding)) {
			hits.push("Buffer.byteLength(non-utf8)");
			throw new Error("pageshim: Buffer.byteLength supports utf8 strings only");
		}
		return new TextEncoder().encode(value).length;
	},
};
export const Buffer = new Proxy(impl, {
	get(t, k) {
		if (k in t) return t[k];
		if (typeof k === "string") hits.push(`Buffer.${k} (missing)`);
		return undefined;
	},
});
