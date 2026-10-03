// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  GrammarError,
  canonicalizeWebHost,
  isCanonicalWebHost,
  canonicalizeConnectHost,
  isCanonicalConnectHost,
  canonicalizeEndpoint,
  isCanonicalEndpoint,
  canonicalizeNetworkHost,
  isCanonicalNetworkHost,
  normalizeFilesystemInputs,
  deepEqualJson,
  hostMatchesWildcardApex,
  findDuplicateJsonKeys,
} from "./connector-binding-grammar.mjs";

test("canonicalizeWebHost: lowercase", () => {
  assert.equal(canonicalizeWebHost("https://EXAMPLE.com"), "https://example.com");
});

test("canonicalizeWebHost: IDNA/UTS46 to ASCII", () => {
  assert.equal(canonicalizeWebHost("https://bücher.example"), "https://xn--bcher-kva.example");
  assert.equal(canonicalizeWebHost("https://xn--bcher-kva.example"), "https://xn--bcher-kva.example");
});

test("canonicalizeWebHost: default ports dropped", () => {
  assert.equal(canonicalizeWebHost("https://example.com:443"), "https://example.com");
  assert.equal(canonicalizeWebHost("http://example.com:80"), "http://example.com");
  assert.equal(canonicalizeWebHost("https://example.com:8443"), "https://example.com:8443");
  assert.equal(canonicalizeWebHost("http://example.com:443"), "http://example.com:443");
});

test("canonicalizeWebHost: IPv6 normalized", () => {
  assert.equal(canonicalizeWebHost("https://[2001:0DB8:0:0:0:0:0:1]"), "https://[2001:db8::1]");
  assert.equal(canonicalizeWebHost("https://[2001:0DB8::1]:443"), "https://[2001:db8::1]");
  assert.equal(canonicalizeWebHost("https://[2001:0DB8::1]:8443"), "https://[2001:db8::1]:8443");
  assert.equal(canonicalizeWebHost("https://[::1]"), "https://[::1]");
});

test("canonicalizeWebHost: rejects IPv4-looking labels", () => {
  for (const input of ["https://0x7f.0.0.1", "https://2130706433", "https://012.0.0.1", "https://1.2.3"]) {
    assert.throws(() => canonicalizeWebHost(input), GrammarError, input);
  }
  // A canonical IPv4 dotted-quad is allowed and left as-is.
  assert.equal(canonicalizeWebHost("https://127.0.0.1"), "https://127.0.0.1");
});

test("canonicalizeWebHost: trailing dot stripped", () => {
  assert.equal(canonicalizeWebHost("https://example.com."), "https://example.com");
  assert.throws(() => canonicalizeWebHost("https://example.com.."), GrammarError);
});

test("canonicalizeWebHost: wildcard only as one leading '*.' label", () => {
  assert.equal(canonicalizeWebHost("https://*.chase.com"), "https://*.chase.com");
  assert.equal(canonicalizeWebHost("*.chase.com"), "*.chase.com");
  for (const input of ["https://*.com", "https://a.*.com", "https://**.example.com", "https://*.127.0.0.1", "https://*.[::1]"]) {
    assert.throws(() => canonicalizeWebHost(input), GrammarError, input);
  }
});

test("canonicalizeWebHost: no path", () => {
  for (const input of ["https://example.com/path", "https://example.com?q=1", "https://example.com#frag"]) {
    assert.throws(() => canonicalizeWebHost(input), GrammarError, input);
  }
});

test("canonicalizeWebHost: omitted scheme and port, empty and malformed input", () => {
  assert.equal(canonicalizeWebHost("example.com"), "example.com");
  assert.equal(canonicalizeWebHost("example.com:8443"), "example.com:8443");
  assert.throws(() => canonicalizeWebHost(""), GrammarError);
  assert.throws(() => canonicalizeWebHost("https://user@example.com"), GrammarError);
  assert.throws(() => canonicalizeWebHost("ftp://example.com"), GrammarError);
  assert.throws(() => canonicalizeWebHost("https://a..b.example"), GrammarError);
  assert.throws(() => canonicalizeWebHost("https://exa mple.com"), GrammarError);
});

test("isCanonicalWebHost is a non-throwing idempotence check", () => {
  assert.equal(isCanonicalWebHost("https://example.com"), true);
  assert.equal(isCanonicalWebHost("https://EXAMPLE.com"), false);
  assert.equal(isCanonicalWebHost("https://example.com:443"), false);
  assert.equal(isCanonicalWebHost(""), false);
  assert.equal(isCanonicalWebHost("not a host"), false);
});

test("canonicalizeConnectHost accepts ws/wss in addition to http/https (live capture: wss://ws.chatgpt.com)", () => {
  assert.equal(canonicalizeConnectHost("wss://ws.chatgpt.com"), "wss://ws.chatgpt.com");
  assert.equal(canonicalizeConnectHost("wss://ws.chatgpt.com:443"), "wss://ws.chatgpt.com");
  assert.equal(canonicalizeConnectHost("ws://example.com:80"), "ws://example.com");
  assert.equal(canonicalizeConnectHost("https://example.com"), "https://example.com");
  assert.equal(canonicalizeConnectHost("*.chatgpt.com"), "*.chatgpt.com");
  assert.equal(canonicalizeConnectHost("wss://*.chatgpt.com"), "wss://*.chatgpt.com");
});

test("canonicalizeConnectHost still rejects a non-web, non-WebSocket scheme and malformed hosts", () => {
  assert.throws(() => canonicalizeConnectHost("ftp://example.com"), GrammarError);
  assert.throws(() => canonicalizeConnectHost("wss://0x7f.0.0.1"), GrammarError);
});

test("canonicalizeWebHost (navigate grammar) still rejects ws/wss: navigation only loads documents", () => {
  assert.throws(() => canonicalizeWebHost("wss://ws.chatgpt.com"), GrammarError);
});

test("isCanonicalConnectHost is a non-throwing idempotence check", () => {
  assert.equal(isCanonicalConnectHost("wss://ws.chatgpt.com"), true);
  assert.equal(isCanonicalConnectHost("WSS://ws.chatgpt.com"), false);
  assert.equal(isCanonicalConnectHost("wss://ws.chatgpt.com:443"), false);
});

test("canonicalizeEndpoint rejects ws/wss, pointing at the connect grammar instead", () => {
  assert.throws(() => canonicalizeEndpoint("wss://ws.chatgpt.com"), GrammarError);
  assert.throws(() => canonicalizeEndpoint("ws://example.com"), GrammarError);
});

test("canonicalizeEndpoint requires an explicit non-HTTP scheme", () => {
  assert.equal(canonicalizeEndpoint("imaps://imap.gmail.com:993"), "imaps://imap.gmail.com");
  assert.equal(canonicalizeEndpoint("imaps://imap.gmail.com"), "imaps://imap.gmail.com");
  assert.equal(canonicalizeEndpoint("imap://imap.example.com:9143"), "imap://imap.example.com:9143");
  assert.throws(() => canonicalizeEndpoint("imap.gmail.com:993"), GrammarError, "no scheme");
  assert.throws(() => canonicalizeEndpoint("https://imap.gmail.com:993"), GrammarError, "http scheme");
  assert.throws(() => canonicalizeEndpoint("xmpp://chat.example.com"), GrammarError, "no known default port");
  assert.throws(() => canonicalizeEndpoint("imaps://*.gmail.com"), GrammarError, "no wildcard");
});

test("canonicalizeEndpoint rejects IPv4-looking labels and normalizes IPv6, like the web grammar", () => {
  assert.throws(() => canonicalizeEndpoint("imaps://0x7f.0.0.1:993"), GrammarError);
  assert.equal(canonicalizeEndpoint("imaps://[2001:0DB8::1]:993"), "imaps://[2001:db8::1]");
});

test("isCanonicalEndpoint is a non-throwing idempotence check", () => {
  assert.equal(isCanonicalEndpoint("imaps://imap.gmail.com"), true);
  assert.equal(isCanonicalEndpoint("imaps://imap.gmail.com:993"), false);
  assert.equal(isCanonicalEndpoint("imap.gmail.com:993"), false);
});

test("canonicalizeNetworkHost dispatches by scheme between the web and endpoint grammars", () => {
  assert.equal(canonicalizeNetworkHost("https://api.github.com"), "https://api.github.com");
  assert.equal(canonicalizeNetworkHost("api.github.com"), "api.github.com");
  assert.equal(canonicalizeNetworkHost("imaps://imap.gmail.com:993"), "imaps://imap.gmail.com");
  assert.equal(isCanonicalNetworkHost("imaps://imap.gmail.com"), true);
  assert.equal(isCanonicalNetworkHost("IMAPS://imap.gmail.com"), false);
});

test("findDuplicateJsonKeys: no duplicates in well-formed text", () => {
  assert.deepEqual(findDuplicateJsonKeys(JSON.stringify({ a: 1, b: { c: 2 } })), []);
});

test("findDuplicateJsonKeys: flags a repeated top-level and nested key", () => {
  const text = `{"a": 1, "b": {"c": 2, "c": 3}, "a": 4}`;
  const found = findDuplicateJsonKeys(text);
  assert.equal(found.length, 2);
  assert.deepEqual(new Set(found.map((d) => d.path)), new Set(["b.c", "a"]));
});

test("findDuplicateJsonKeys: flags a duplicate binding instance key", () => {
  const text = `{"runtime_requirements": {"bindings": {"x": {"required": true}, "x": {"required": false}}}}`;
  const found = findDuplicateJsonKeys(text);
  assert.deepEqual(found, [{ path: "runtime_requirements.bindings.x", key: "x" }]);
});

test("findDuplicateJsonKeys: a string value that looks like a key is not flagged", () => {
  const text = `{"a": "has: a colon", "b": 2}`;
  assert.deepEqual(findDuplicateJsonKeys(text), []);
});

test("findDuplicateJsonKeys: escaped quotes inside strings do not confuse the scanner", () => {
  const text = `{"a\\"b": 1, "c": "x\\"y", "c": 2}`;
  const found = findDuplicateJsonKeys(text);
  assert.deepEqual(found, [{ path: "c", key: "c" }]);
});

const dirInput = (envVar) => ({ env_var: envVar, kind: "dir", access: "read" });

test("normalizeFilesystemInputs: neither form present", () => {
  assert.equal(normalizeFilesystemInputs({}), undefined);
});

test("normalizeFilesystemInputs: only the legacy top-level form", () => {
  const inputs = [dirInput("EXAMPLE_DIR")];
  assert.equal(normalizeFilesystemInputs({ inputs }), inputs);
});

test("normalizeFilesystemInputs: only constraints.inputs", () => {
  const inputs = [dirInput("EXAMPLE_DIR")];
  assert.equal(normalizeFilesystemInputs({ constraints: { inputs } }), inputs);
});

test("normalizeFilesystemInputs: both forms present and equal (order-independent) normalize to one", () => {
  const a = dirInput("A_DIR");
  const b = dirInput("B_DIR");
  const instance = { inputs: [a, b], constraints: { inputs: [b, a] } };
  assert.deepEqual(normalizeFilesystemInputs(instance), [a, b]);
});

test("normalizeFilesystemInputs: both forms present but disagree is rejected", () => {
  const instance = { inputs: [dirInput("A_DIR")], constraints: { inputs: [dirInput("B_DIR")] } };
  assert.throws(() => normalizeFilesystemInputs(instance), GrammarError);
});

test("normalizeFilesystemInputs: same env_var, different accepted_extensions is rejected, not just compared by env_var", () => {
  const instance = {
    inputs: [{ env_var: "A_DIR", kind: "dir", access: "read" }],
    constraints: { inputs: [{ env_var: "A_DIR", kind: "dir", access: "read", accepted_extensions: [".zip"] }] },
  };
  assert.throws(() => normalizeFilesystemInputs(instance), GrammarError);
});

test("normalizeFilesystemInputs: same env_var, different kind is rejected", () => {
  const instance = {
    inputs: [{ env_var: "A_DIR", kind: "dir", access: "read" }],
    constraints: { inputs: [{ env_var: "A_DIR", kind: "file", access: "read" }] },
  };
  assert.throws(() => normalizeFilesystemInputs(instance), GrammarError);
});

test("findDuplicateJsonKeys: object values inside an array do not escape their own scope", () => {
  const text = `{"list": [{"a": 1, "a": 2}, {"a": 1}]}`;
  const found = findDuplicateJsonKeys(text);
  assert.deepEqual(found, [{ path: "list.[].a", key: "a" }]);
});

test("canonicalizeEndpoint: a scheme named after an Object.prototype member has no default port and is rejected, not silently accepted", () => {
  for (const scheme of ["constructor", "tostring", "hasownproperty", "valueof", "isprototypeof"]) {
    assert.throws(() => canonicalizeEndpoint(`${scheme}://example.com`), GrammarError, scheme);
  }
  // A real __proto__-named scheme is syntactically impossible (a scheme must
  // start with a letter, RFC 3986), so it is rejected for that reason instead.
  assert.throws(() => canonicalizeEndpoint("__proto__://example.com"), GrammarError);
});

test("canonicalizeEndpoint: a scheme with a real default port is unaffected by the prototype-pollution fix", () => {
  assert.equal(canonicalizeEndpoint("imaps://imap.example.com"), "imaps://imap.example.com");
});

test("canonicalizeWebHost: a 63-octet label is accepted, a 64-octet label is rejected", () => {
  const label63 = "a".repeat(63);
  const label64 = "a".repeat(64);
  assert.equal(canonicalizeWebHost(`https://${label63}.com`), `https://${label63}.com`);
  assert.throws(() => canonicalizeWebHost(`https://${label64}.com`), GrammarError);
});

test("deepEqualJson: object member order does not affect equality", () => {
  const a = { env_var: "A_DIR", kind: "dir", access: "read" };
  const b = { access: "read", kind: "dir", env_var: "A_DIR" };
  assert.equal(deepEqualJson(a, b), true);
  assert.equal(deepEqualJson(a, { ...a, kind: "file" }), false);
});

test("deepEqualJson: array element order still matters", () => {
  assert.equal(deepEqualJson([".zip", ".xml"], [".xml", ".zip"]), false);
  assert.equal(deepEqualJson([".zip", ".xml"], [".zip", ".xml"]), true);
});

test("normalizeFilesystemInputs: both forms present, same entries in a different member order, is accepted", () => {
  const topLevel = [{ env_var: "A_DIR", kind: "dir", access: "read" }];
  const nested = [{ access: "read", kind: "dir", env_var: "A_DIR" }];
  assert.deepEqual(normalizeFilesystemInputs({ inputs: topLevel, constraints: { inputs: nested } }), topLevel);
});

test("hostMatchesWildcardApex: matches one or more leftmost labels (CSP host-source convention), never the bare apex", () => {
  assert.equal(hostMatchesWildcardApex("example.com", "a.example.com"), true, "one label matches");
  assert.equal(hostMatchesWildcardApex("example.com", "a.b.example.com"), true, "two or more labels still match");
  assert.equal(hostMatchesWildcardApex("example.com", "example.com"), false, "the bare apex is not matched");
  assert.equal(hostMatchesWildcardApex("example.com", "badexample.com"), false, "a label boundary is required, not just a string suffix");
  assert.equal(hostMatchesWildcardApex("example.com", "example.com.evil.com"), false);
  // Real capture evidence: *.redditmedia.com must cover a second-level label.
  assert.equal(hostMatchesWildcardApex("redditmedia.com", "b.thumbs.redditmedia.com"), true);
});
