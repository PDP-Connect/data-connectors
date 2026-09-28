// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure posix `path` subset (harmless shim: string ops only).
const norm = (p) => {
	const abs = p.startsWith("/");
	const out = [];
	for (const s of p.split("/")) {
		if (!s || s === ".") continue;
		if (s === "..") {
			if (out.length && out[out.length - 1] !== "..") out.pop();
			else if (!abs) out.push("..");
		} else out.push(s);
	}
	return (abs ? "/" : "") + out.join("/") || (abs ? "/" : ".");
};
export const sep = "/";
export const delimiter = ":";
export const normalize = norm;
export const join = (...a) => norm(a.filter(Boolean).join("/"));
export const resolve = (...a) => {
	let r = "";
	for (const s of a) r = s.startsWith("/") ? s : `${r}/${s}`;
	return norm(r.startsWith("/") ? r : `/${r}`);
};
export const dirname = (p) => {
	const n = norm(p);
	const i = n.lastIndexOf("/");
	return i <= 0 ? (i === 0 ? "/" : ".") : n.slice(0, i);
};
export const basename = (p, ext) => {
	const b = norm(p).split("/").pop() || "";
	return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
};
export const extname = (p) => {
	const b = basename(p);
	const i = b.lastIndexOf(".");
	return i > 0 ? b.slice(i) : "";
};
export const isAbsolute = (p) => p.startsWith("/");
export const relative = (from, to) => {
	const f = norm(from).split("/").filter(Boolean);
	const t = norm(to).split("/").filter(Boolean);
	while (f.length && t.length && f[0] === t[0]) {
		f.shift();
		t.shift();
	}
	return [...f.map(() => ".."), ...t].join("/");
};
export const posix = {
	sep,
	delimiter,
	normalize,
	join,
	resolve,
	dirname,
	basename,
	extname,
	isAbsolute,
	relative,
};
export default posix;
