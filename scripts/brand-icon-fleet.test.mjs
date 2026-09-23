// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import test from "node:test";

const repoRoot = join(dirname(new URL(import.meta.url).pathname), "..");
const manifestsDir = join(repoRoot, "connectors");
const indexPath = join(repoRoot, "connector-index.json");
const expectedUrlPrefix = "https://raw.githubusercontent.com/PDP-Connect/data-connectors/";
const drawableElementPattern = /<(?:path|rect|circle|ellipse|line|polygon|polyline)\b[^>]*>/g;

function iconPathFromUrl(url) {
  const match = url.match(/\/(?:packages\/polyfill-connectors\/manifests\/icons\/([^/?#]+)\.svg|connectors\/([^/?#]+)\/icon\.svg)$/);
  assert.ok(match, `${url}: must resolve to a pinned connector icon`);
  return `connectors/${match[1] ?? match[2]}/icon.svg`;
}

function parseSquareViewBox(source, filename) {
  const root = source.match(/^\s*<svg\b([^>]*)>/);
  assert.ok(root, `${filename}: SVG root is required`);
  assert.doesNotMatch(root[1], /(?:^|\s)(?:width|height)\s*=/i, `${filename}: root must not fix width or height`);
  const viewBox = root[1].match(/\bviewBox\s*=\s*["']\s*0\s+0\s+([0-9.]+)\s+([0-9.]+)\s*["']/i);
  assert.ok(viewBox, `${filename}: viewBox must start at 0 0`);
  assert.equal(viewBox[1], viewBox[2], `${filename}: viewBox must be square`);
  return viewBox[1];
}

function assertSafeRecognisableSvg(source, filename) {
  const viewBoxSize = parseSquareViewBox(source, filename);
  assert.doesNotMatch(source, /<\/?(?:script|image|use|foreignObject|text)\b/i, `${filename}: may not embed scripts, external content, or text`);
  assert.doesNotMatch(source, /\b(?:href|xlink:href)\s*=\s*["'](?:https?:|\/\/|data:)/i, `${filename}: may not reference external content`);
  const drawables = source.match(drawableElementPattern) ?? [];
  assert.ok(drawables.length > 0, `${filename}: must contain a drawable brand mark`);
  assert.match(source, /<(?:svg|path|rect|circle|ellipse|line|polygon|polyline)\b[^>]*\b(?:fill|stroke)\s*=/i, `${filename}: must declare an intentional fill or stroke`);

  const onlyDrawable = drawables.length === 1 ? drawables[0] : null;
  if (onlyDrawable) {
    const escapedSize = viewBoxSize.replace(".", "\\.");
    const isFilledRect = /^<rect\b/i.test(onlyDrawable) && new RegExp(`\\bx\\s*=\\s*["']?0(?:["'\\s>])`).test(onlyDrawable) && new RegExp(`\\by\\s*=\\s*["']?0(?:["'\\s>])`).test(onlyDrawable) && new RegExp(`\\bwidth\\s*=\\s*["']?(?:${escapedSize}|100%)(?:["'\\s>])`).test(onlyDrawable) && new RegExp(`\\bheight\\s*=\\s*["']?(?:${escapedSize}|100%)(?:["'\\s>])`).test(onlyDrawable);
    const isFilledCircle = /^<circle\b/i.test(onlyDrawable) && /\bcx\s*=\s*["']?(?:50%|12)(?:["'\s>])/i.test(onlyDrawable) && /\bcy\s*=\s*["']?(?:50%|12)(?:["'\s>])/i.test(onlyDrawable) && /\br\s*=\s*["']?(?:50%|12)(?:["'\s>])/i.test(onlyDrawable);
    assert.equal(isFilledRect || isFilledCircle, false, `${filename}: must not be a single viewBox-covering placeholder shape`);
  }
}

// Connectors with no legitimate brand mark available in any vendored, offline,
// build-time-only source checked (verified, not assumed): simple-icons v16.31.0
// (slack/openai/pocket removed after brand-owner takedown/product-retirement;
// whoop/ynab/oura never added; heb/usaa/wholefoods/google_takeout have no
// vendor-published entry), home-assistant/brands (PNG-only, incompatible with
// this repo's SVG-only pipeline; also has zero coverage of heb/pocket/usaa/
// wholefoods/ynab/google_takeout even as PNG), and @iconify/json's `logos`
// collection (CC0-1.0, ~2,174 marks) — this last source covers codex and
// slack, but not heb/oura/pocket/usaa/wholefoods/whoop/ynab. codex.svg and
// slack.svg were vendored from that collection's `codex` and `slack-icon`
// keys respectively (256x256 source viewBox), rescaled to this fleet's
// 0 0 24 24 grid via a uniform linear transform (svgpath(...).scale(24/256)),
// with slack-icon's 4 separate colored <path> elements merged into one path
// under a single root fill="#FFFFFF" to match every other icon here. These
// manifests declare no `brand` object at all, so the console falls back to
// the deterministic monogram rather than shipping an invented or hand-drawn
// logo. See /home/tnunamak/code/pdpp/local/ICON-SOURCES-0918.md for full
// source research and coverage numbers, and ICON-ART-0918.md for the
// original per-connector removal verdict.
const CONNECTORS_WITHOUT_A_BRAND_MARK = new Set([
  "heb.json",
  "google_takeout.json",
  "oura.json",
  "pocket.json",
  "usaa.json",
  "wholefoods.json",
  "whoop.json",
  "ynab.json",
]);

function assertRealBrandMarkShape(source, filename) {
  const root = source.match(/^\s*<svg\b([^>]*)>/);
  assert.ok(root, `${filename}: SVG root is required`);
  const viewBox = root[1].match(/\bviewBox\s*=\s*["']([^"']*)["']/i);
  assert.ok(viewBox, `${filename}: viewBox is required`);
  assert.equal(viewBox[1].replace(/\s+/g, " ").trim(), "0 0 24 24", `${filename}: viewBox must be exactly "0 0 24 24"`);
  assert.doesNotMatch(source, /\bstroke\s*=/i, `${filename}: real brand marks are filled paths, not stroke-based glyphs`);
  const innerFills = source.slice(root[0].length).match(/\bfill\s*=/gi) ?? [];
  assert.equal(innerFills.length, 0, `${filename}: fill must be declared once on the root <svg>, not overridden on inner elements`);
  const svgTagCount = (source.match(/<svg\b/g) ?? []).length;
  assert.equal(svgTagCount, 1, `${filename}: must be a single bare <svg> root`);
}

function readManifest(filename) {
  const path = join(manifestsDir, filename.replace(/\.json$/, ""), "manifest.json");
  return { path, manifest: JSON.parse(readFileSync(path, "utf8")) };
}

function manifestFiles() {
  return readdirSync(manifestsDir)
    .filter((key) => existsSync(join(manifestsDir, key, "manifest.json")))
    .map((key) => `${key}.json`)
    .sort();
}

function assertLocalAsset(manifestPath, assetPath, field) {
  assert.equal(typeof assetPath, "string", `${manifestPath}: brand.${field} must be a string`);
  assert.notEqual(assetPath.trim(), "", `${manifestPath}: brand.${field} must not be empty`);
  assert.equal(assetPath.startsWith("/"), false, `${manifestPath}: brand.${field} must be relative`);
  assert.equal(assetPath.includes("\\"), false, `${manifestPath}: brand.${field} must use POSIX separators`);
  const normalized = normalize(assetPath);
  assert.equal(normalized.startsWith(".."), false, `${manifestPath}: brand.${field} must stay local`);
  const resolved = join(dirname(manifestPath), normalized);
  assert.equal(existsSync(resolved) && statSync(resolved).isFile(), true, `${manifestPath}: brand.${field} asset is missing`);
  return assetPath;
}

test("every shipped polyfill manifest either declares a local brand icon or has none (monogram fallback)", () => {
  const files = manifestFiles();
  assert.ok(files.length > 0, "expected shipped polyfill manifests");
  for (const filename of files) {
    const { path, manifest } = readManifest(filename);
    assert.equal(typeof manifest.connector_id, "string", `${filename}: connector_id is required`);
    if (manifest.brand === undefined) {
      assert.ok(CONNECTORS_WITHOUT_A_BRAND_MARK.has(filename), `${filename}: has no brand — either add one or add it to CONNECTORS_WITHOUT_A_BRAND_MARK`);
      continue;
    }
    assert.ok(manifest.brand && typeof manifest.brand === "object" && !Array.isArray(manifest.brand), `${filename}: brand must be an object when present`);
    assertLocalAsset(path, manifest.brand.icon, "icon");
    if (manifest.brand.dark_icon !== undefined) assertLocalAsset(path, manifest.brand.dark_icon, "dark_icon");
  }

  for (const filename of CONNECTORS_WITHOUT_A_BRAND_MARK) {
    assert.ok(files.includes(filename), `${filename}: no longer exists — remove it from CONNECTORS_WITHOUT_A_BRAND_MARK`);
  }
});

test("connector index resolves every shipped polyfill brand icon, and omits connectors with none", () => {
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  for (const filename of manifestFiles()) {
    const { manifest } = readManifest(filename);
    if (manifest.brand === undefined) {
      assert.equal(index.brandIcons?.[manifest.connector_id], undefined, `${filename}: has no brand but connector-index.json still has a brandIcons entry`);
      continue;
    }
    const icon = index.brandIcons?.[manifest.connector_id];
    assert.ok(icon, `${filename}: connector-index.json is missing brandIcons.${manifest.connector_id}`);
    assert.match(
      icon.url,
      new RegExp(`^${expectedUrlPrefix}[0-9a-f]{40}/(?:packages/polyfill-connectors/manifests/icons/${filename.replace(/\.json$/, "")}.svg|connectors/${filename.replace(/\.json$/, "")}/${manifest.brand.icon})$`),
      `${filename}: resolved icon URL`,
    );
    if (manifest.brand.dark_icon !== undefined) {
      assert.match(
        icon.darkUrl,
        new RegExp(`^${expectedUrlPrefix}[0-9a-f]{40}/(?:packages/polyfill-connectors/manifests/icons/${filename.replace(/\.json$/, "")}.svg|connectors/${filename.replace(/\.json$/, "")}/${manifest.brand.dark_icon})$`),
        `${filename}: resolved dark icon URL`,
      );
    }
    assert.equal(icon.backgroundColor, manifest.brand.background_color, `${filename}: background color`);
  }
});

test("every indexed brand icon is a self-contained, intentionally inked SVG mark", () => {
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const referenced = Object.values(index.brandIcons ?? {});
  const expectedCount = manifestFiles().length - CONNECTORS_WITHOUT_A_BRAND_MARK.size;
  assert.equal(referenced.length, expectedCount, "expected every shipped connector with a brand mark to be indexed, and no others");

  for (const icon of referenced) {
    assert.equal(typeof icon?.url, "string", "brand icon URL is required");
    const relativePath = iconPathFromUrl(icon.url);
    const source = readFileSync(join(repoRoot, relativePath), "utf8");
    assertSafeRecognisableSvg(source, relativePath);
    if (icon.darkUrl !== undefined) {
      assert.equal(typeof icon.darkUrl, "string", `${relativePath}: darkUrl must be a string`);
      const darkPath = iconPathFromUrl(icon.darkUrl);
      assertSafeRecognisableSvg(readFileSync(join(repoRoot, darkPath), "utf8"), darkPath);
    }
  }
});

test("every indexed brand icon is a real brand mark, not a hand-drawn glyph", () => {
  // Every connector without a confidently-sourced brand mark has been dropped from the
  // index (see CONNECTORS_WITHOUT_A_BRAND_MARK above) rather than shipping a placeholder,
  // so nothing indexed here should need an exemption. This guard exists to catch a
  // regression: a future manifest that adds a `brand.icon` pointing at a hand-drawn glyph.
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const referenced = Object.values(index.brandIcons ?? {});

  for (const icon of referenced) {
    const relativePath = iconPathFromUrl(icon.url);
    const source = readFileSync(join(repoRoot, relativePath), "utf8");
    assertRealBrandMarkShape(source, relativePath);
  }
});
