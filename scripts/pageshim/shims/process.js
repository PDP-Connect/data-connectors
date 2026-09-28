// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Bundle-local `process`. The PageShim passes a frozen `process = {env: {}}`
// param; bundled Node code also reads argv/stdin/exitCode/etc. Every access is
// recorded so the report can say which parts of `process` the connector really
// touched at runtime.
globalThis.__pdppStubHits ??= [];
const hits = globalThis.__pdppStubHits;
const noopEmitter = (name) =>
	new Proxy(
		{},
		{
			get(_t, k) {
				if (typeof k === "symbol" || k === "then") return undefined;
				if (k === "isTTY") return false;
				return (...args) => {
					hits.push(`${name}.${String(k)}()`);
					if (k === "write") {
						const s = String(args[0] ?? "");
						if (name === "process.stderr") console.log(s.slice(0, 300));
						return true;
					}
					return undefined;
				};
			},
		},
	);
const base = {
	env: {},
	argv: [],
	execArgv: [],
	platform: "linux",
	versions: {},
	version: "",
	pid: 0,
	exitCode: undefined,
	stdin: noopEmitter("process.stdin"),
	stdout: noopEmitter("process.stdout"),
	stderr: noopEmitter("process.stderr"),
	cwd() {
		hits.push("process.cwd()");
		return "/";
	},
	exit(code) {
		hits.push(`process.exit(${code})`);
		throw new Error(`pageshim: process.exit(${code}) unavailable`);
	},
	nextTick(fn, ...a) {
		queueMicrotask(() => fn(...a));
	},
	hrtime: Object.assign(() => [0, 0], {
		bigint: () => BigInt(Math.round(performance.now() * 1e6)),
	}),
	memoryUsage: () => ({ rss: 0, heapUsed: 0, heapTotal: 0, external: 0 }),
	on() {
		return base;
	},
	once() {
		return base;
	},
	off() {
		return base;
	},
	emitWarning() {},
};
export const process = new Proxy(base, {
	get(t, k) {
		if (k in t) return t[k];
		if (typeof k === "string") hits.push(`process.${k} (missing)`);
		return undefined;
	},
});
