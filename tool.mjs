import { Resvg } from "@resvg/resvg-js";
import svgpath from "svgpath";
import { optimize } from "svgo";

export function flattenToPaths(svg) {
	const { data } = optimize(svg, {
		multipass: true,
		plugins: [
			{ name: "preset-default", params: { overrides: { mergePaths: false, convertPathData: { floatPrecision: 4 } } } },
			"convertStyleToAttrs",
		],
	});
	const paths = [];
	const re = /<path\b([^>]*)\/?>(?:<\/path>)?/g;
	for (const m of data.matchAll(re)) {
		const attrs = m[1];
		const d = attrs.match(/\bd="([^"]*)"/)?.[1];
		const fill = attrs.match(/\bfill="([^"]*)"/)?.[1] ?? null;
		const transform = attrs.match(/\btransform="([^"]*)"/)?.[1] ?? null;
		paths.push({ d: transform ? svgpath(d).transform(transform).toString() : d, fill, raw: attrs.slice(0, 80) });
	}
	if (/<(?:rect|circle|ellipse|polygon|polyline|line|g\b[^>]*transform)/.test(data)) {
		throw new Error(`unflattened shapes remain: ${data.slice(0, 400)}`);
	}
	return { optimized: data, paths };
}

// Split into absolute subpaths of {start, segs:[{cmd:'L'|'C'|'Q', pts:[...]}]}.
export function subpaths(d) {
	const out = [];
	let cur = null;
	let x = 0;
	let y = 0;
	svgpath(d)
		.abs()
		.unarc()
		.unshort()
		.iterate((seg) => {
			const [c, ...a] = seg;
			if (c === "M") {
				cur = { start: [a[0], a[1]], segs: [] };
				out.push(cur);
				[x, y] = a;
			} else if (c === "L") {
				cur.segs.push({ cmd: "L", pts: [[a[0], a[1]]] });
				[x, y] = a;
			} else if (c === "H") {
				cur.segs.push({ cmd: "L", pts: [[a[0], y]] });
				x = a[0];
			} else if (c === "V") {
				cur.segs.push({ cmd: "L", pts: [[x, a[0]]] });
				y = a[0];
			} else if (c === "C") {
				cur.segs.push({ cmd: "C", pts: [[a[0], a[1]], [a[2], a[3]], [a[4], a[5]]] });
				[x, y] = [a[4], a[5]];
			} else if (c === "Q") {
				cur.segs.push({ cmd: "Q", pts: [[a[0], a[1]], [a[2], a[3]]] });
				[x, y] = [a[2], a[3]];
			} else if (c === "Z") {
				[x, y] = cur.start;
				// A following command without M starts at the subpath start.
				const start = cur.start;
				cur = { start, segs: [] };
				out.push(cur);
			} else throw new Error(`unexpected ${c}`);
		});
	return out.filter((s) => s.segs.length > 0);
}

function polygon(sp) {
	const pts = [sp.start];
	let p = sp.start;
	for (const s of sp.segs) {
		if (s.cmd === "L") pts.push(s.pts[0]);
		else {
			const ctrl = [p, ...s.pts];
			for (let i = 1; i <= 24; i++) {
				const t = i / 24;
				let q = ctrl;
				while (q.length > 1) q = q.slice(1).map((b, k) => [q[k][0] + (b[0] - q[k][0]) * t, q[k][1] + (b[1] - q[k][1]) * t]);
				pts.push(q[0]);
			}
		}
		p = s.pts[s.pts.length - 1];
	}
	return pts;
}

function area(poly) {
	let a = 0;
	for (let i = 0; i < poly.length; i++) {
		const [x1, y1] = poly[i];
		const [x2, y2] = poly[(i + 1) % poly.length];
		a += x1 * y2 - x2 * y1;
	}
	return a / 2;
}

function inside([px, py], poly) {
	let c = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const [xi, yi] = poly[i];
		const [xj, yj] = poly[j];
		if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
	}
	return c;
}

function reverse(sp) {
	const nodes = [sp.start];
	for (const s of sp.segs) nodes.push(s.pts[s.pts.length - 1]);
	const segs = [];
	for (let i = sp.segs.length - 1; i >= 0; i--) {
		const s = sp.segs[i];
		const to = nodes[i];
		if (s.cmd === "L") segs.push({ cmd: "L", pts: [to] });
		else if (s.cmd === "Q") segs.push({ cmd: "Q", pts: [s.pts[0], to] });
		else segs.push({ cmd: "C", pts: [s.pts[1], s.pts[0], to] });
	}
	return { start: nodes[nodes.length - 1], segs };
}

export function serialize(sps) {
	return sps
		.map((sp) => `M${sp.start.join(" ")}${sp.segs.map((s) => s.cmd + s.pts.map((p) => p.join(" ")).join(" ")).join("")}Z`)
		.join("");
}

// Rewrites an even-odd path so it fills identically under the default nonzero rule:
// each subpath winds by the parity of how many other subpaths contain it.
export function evenOddToNonzero(d) {
	const sps = subpaths(d);
	const polys = sps.map(polygon);
	return serialize(
		sps.map((sp, i) => {
			const probe = polys[i][0];
			const depth = polys.filter((other, j) => j !== i && inside(probe, other)).length;
			const want = depth % 2 === 0 ? 1 : -1;
			return Math.sign(area(polys[i])) === want ? sp : reverse(sp);
		}),
	);
}

export function bboxOf(d) {
	const b = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path d="${d}"/></svg>`).getBBox();
	return { x: b.x, y: b.y, width: b.width, height: b.height };
}

export function fitTo24(d) {
	const probe = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path d="${d}"/></svg>`);
	const b = probe.getBBox();
	const scale = 24 / Math.max(b.width, b.height);
	const tx = (24 - b.width * scale) / 2 - b.x * scale;
	const ty = (24 - b.height * scale) / 2 - b.y * scale;
	return svgpath(d).translate(0, 0).scale(scale).translate(tx, ty).round(3).toString();
}

export function minifyPath(d) {
	const { data } = optimize(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${d}"/></svg>`, {
		plugins: [{ name: "convertPathData", params: { floatPrecision: 3, transformPrecision: 5 } }],
	});
	return data.match(/\bd="([^"]*)"/)[1];
}

export function iconSvg(d) {
	return `<svg fill="#FFFFFF" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${d}"/></svg>`;
}

export function renderOnBackground(iconSource, background, size = 128) {
	const inner = iconSource.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
	const pad = 4;
	const wrapped = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${24 + 2 * pad} ${24 + 2 * pad}" width="${size}" height="${size}"><rect x="${-pad}" y="${-pad}" width="${24 + 2 * pad}" height="${24 + 2 * pad}" rx="6" fill="${background}"/><g fill="#FFFFFF">${inner}</g></svg>`;
	return new Resvg(wrapped).render().asPng();
}
