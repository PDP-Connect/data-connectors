import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import * as si from "simple-icons";
import svgpath from "svgpath";
import { bboxOf, evenOddToNonzero, flattenToPaths, iconSvg, minifyPath, renderOnBackground, serialize, subpaths } from "./tool.mjs";

const SRC = new URL("../icons-src/", import.meta.url).pathname;
const read = (f) => readFileSync(SRC + f, "utf8");
const siPath = (svg) => svg.match(/ d="([^"]*)"/)[1];

// Each source yields the brand mark's path data and the fill rule it was drawn with.
const sources = {
	facebook: { d: si.siFacebook.path, rule: "nonzero", bg: `#${si.siFacebook.hex}`, via: "simple-icons@16.36.0 facebook" },
	fitbit: { d: si.siFitbit.path, rule: "nonzero", bg: `#${si.siFitbit.hex}`, via: "simple-icons@16.36.0 fitbit" },
	garmin: { d: si.siGarmin.path, rule: "nonzero", bg: `#${si.siGarmin.hex}`, via: "simple-icons@16.36.0 garmin" },
	google: { d: si.siGoogle.path, rule: "nonzero", bg: `#${si.siGoogle.hex}`, via: "simple-icons@16.36.0 google" },
	meta: { d: si.siMeta.path, rule: "nonzero", bg: `#${si.siMeta.hex}`, via: "simple-icons@16.36.0 meta" },
	perplexity: { d: si.siPerplexity.path, rule: "nonzero", bg: `#${si.siPerplexity.hex}`, via: "simple-icons@16.36.0 perplexity" },
	tiktok: { d: si.siTiktok.path, rule: "nonzero", bg: `#${si.siTiktok.hex}`, via: "simple-icons@16.36.0 tiktok" },
	pocket: { d: siPath(read("si15-pocket.svg")), rule: "nonzero", bg: "#EF3F56", via: "simple-icons@15.22.0 pocket" },
	character_ai: {
		d: flattenToPaths(read("cai-icon.plain.svg")).paths.filter((p) => /^#fff/i.test(p.fill)).map((p) => p.d).join(""),
		rule: "nonzero",
		bg: "#000000",
		via: "https://character.ai/icon.svg",
	},
	heb: {
		d: read("heb-logo.svg").match(/ d="([^"]*)"/)[1],
		rule: "nonzero",
		bg: "#E1251B",
		via: "https://www.heb.com/ header logo",
	},
	instinct: {
		d: read("instinct-wordmark.svg").match(/ d="([^"]*)"/)[1],
		rule: "nonzero",
		bg: "#1F2322",
		via: "https://instinct.com/redesign/wordmark.svg (I glyph, as app.instinct.com/favicon.ico)",
	},
	oura: {
		d: [...read("oura-wordmark-white.svg").matchAll(/ d="([^"]*)"/g)].map((m) => m[1]).join(""),
		rule: "evenodd",
		bg: "#2F4A73",
		via: "https://static.ouraring.com/pdfs/Oura_BrandGuidelines_v1.pdf p.5 white logo",
	},
	usaa: {
		d: read("usaa-fav.svg").match(/fill-rule="evenodd" d="([^"]*)"/)[1],
		rule: "evenodd",
		bg: "#12395B",
		via: "https://www.usaa.com/favicon.svg",
	},
	wholefoods: {
		d: wfmLeafO(),
		rule: "evenodd",
		bg: "#046F46",
		via: "https://www.wholefoodsmarket.com/ header logo (leaf O, as the site favicon)",
	},
	whoop: {
		d: (() => {
			const all = [...read("whoop-logos/Logo/Circle/WHOOP Circle White.svg").matchAll(/ d="([^"]*)"/g)].map((m) => m[1]);
			return all.filter((d) => !d.startsWith("M29.5 29C")).join("");
		})(),
		rule: "evenodd",
		bg: "#000000",
		via: "https://developer.whoop.com/docs/developing/design-guidelines Logos zip, Circle White",
	},
	ynab: {
		d: [...read("ynab-tree-blurple.svg").matchAll(/ d="([^"]*)"/g)].map((m) => m[1]).join(""),
		rule: "nonzero",
		bg: "#3B5EDA",
		via: "https://www.ynab.com/press Tree Logo",
	},
};

function wfmLeafO() {
	const d = read("wfm-logo.svg").match(/ d="([^"]*)"/)[1];
	// The leaf-topped O of WHOLE is the glyph Whole Foods ships as its favicon.
	const picked = subpaths(d).filter((sp) => {
		const b = bboxOf(serialize([sp]));
		return b.y < 1 && b.height > 20;
	});
	return serialize(picked);
}

export const connectors = {
	character_ai: "character_ai",
	facebook: "facebook",
	fitbit: "fitbit",
	garmin_browser: "garmin",
	google_takeout: "google",
	heb: "heb",
	instinct: "instinct",
	muse: "meta",
	oura: "oura",
	oura_browser: "oura",
	perplexity: "perplexity",
	pocket: "pocket",
	tiktok: "tiktok",
	usaa: "usaa",
	wholefoods: "wholefoods",
	whoop: "whoop",
	whoop_browser: "whoop",
	ynab: "ynab",
};

function fitTransform(d) {
	const b = bboxOf(d);
	const s = 24 / Math.max(b.width, b.height);
	return { s, tx: (24 - b.width * s) / 2 - b.x * s, ty: (24 - b.height * s) / 2 - b.y * s };
}

function alpha(svg, size = 240) {
	const px = new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().pixels;
	const a = new Uint8Array(px.length / 4);
	for (let i = 0; i < a.length; i++) a[i] = px[i * 4 + 3];
	return a;
}

mkdirSync("out/icons", { recursive: true });
const report = {};
for (const [name, src] of Object.entries(sources)) {
	const verbatim = src.via.startsWith("simple-icons@");
	const nonzero = src.rule === "evenodd" ? evenOddToNonzero(src.d) : src.d;
	const { s, tx, ty } = verbatim ? { s: 1, tx: 0, ty: 0 } : fitTransform(src.d);
	const d = verbatim ? src.d : minifyPath(svgpath(nonzero).scale(s).translate(tx, ty).round(3).toString());
	const icon = iconSvg(d);
	const reference = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#fff" fill-rule="${src.rule}" transform="translate(${tx} ${ty}) scale(${s})" d="${src.d}"/></svg>`;
	const a = alpha(reference);
	const b = alpha(icon);
	let diff = 0;
	for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 64) diff++;
	report[name] = { bytes: icon.length, diffPixels: diff, ofPixels: a.length, bg: src.bg, via: src.via };
	writeFileSync(`out/icons/${name}.svg`, `${icon}\n`);
	writeFileSync(`out/icons/${name}.png`, renderOnBackground(icon, src.bg, 160));
}
writeFileSync("out/report.json", JSON.stringify(report, null, 2));
console.table(report);

const REPO = new URL("../dc-wt/brand-icons/", import.meta.url).pathname;
const tiles = [
	...Object.entries(connectors).map(([key, name]) => ({ key, icon: readFileSync(`out/icons/${name}.svg`, "utf8"), bg: sources[name].bg })),
	...["chatgpt", "strava", "github", "meta", "google_contacts", "icloud_notes"].map((key) => ({
		key: `${key} (existing)`,
		icon: readFileSync(`${REPO}connectors/${key}/icon.svg`, "utf8"),
		bg: JSON.parse(readFileSync(`${REPO}connectors/${key}/manifest.json`, "utf8")).brand.background_color,
	})),
];
const cols = 6;
const cell = 150;
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cell}" height="${Math.ceil(tiles.length / cols) * (cell + 10)}"><rect width="100%" height="100%" fill="#F4F4F5"/>${tiles
	.map((t, i) => {
		const x = (i % cols) * cell + 25;
		const y = Math.floor(i / cols) * (cell + 10) + 12;
		const inner = t.icon.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
		return `<rect x="${x}" y="${y}" width="100" height="100" rx="22" fill="${t.bg}"/><g fill="#FFFFFF" transform="translate(${x + 25} ${y + 25}) scale(${50 / 24})">${inner}</g><text x="${x + 50}" y="${y + 122}" font-family="Helvetica, Arial, sans-serif" font-size="12" text-anchor="middle" fill="#18181B">${t.key}</text><text x="${x + 50}" y="${y + 137}" font-family="Menlo, monospace" font-size="10" text-anchor="middle" fill="#52525B">${t.bg}</text>`;
	})
	.join("")}</svg>`;
writeFileSync("out/contact-sheet.png", new Resvg(sheet, { font: { loadSystemFonts: true } }).render().asPng());
