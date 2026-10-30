// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import test from "node:test";

const repoRoot = join(dirname(new URL(import.meta.url).pathname), "..");
const manifestsDir = join(repoRoot, "connectors");
const drawableElementPattern = /<(?:path|rect|circle|ellipse|line|polygon|polyline)\b[^>]*>/g;

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

// Icon provenance. Most marks are simple-icons paths used verbatim (16.36.0;
// pocket from 15.22.0, the last release that carried it before Pocket shut
// down). codex.svg and slack.svg come from @iconify/json's CC0 `logos`
// collection, rescaled from 256 to 24 and merged into one path. Brands that
// simple-icons does not carry use the owner's own published vector, keeping
// only the mark's white shape (no ® glyph), scaled uniformly to fit 24x24, and
// rewritten from even-odd to nonzero filling where needed:
//   character_ai  https://character.ai/icon.svg
//   heb           https://www.heb.com/ header logo
//   instinct      https://instinct.com/redesign/wordmark.svg, the "I" glyph
//                 that app.instinct.com/favicon.ico shows
//   oura*         https://static.ouraring.com/pdfs/Oura_BrandGuidelines_v1.pdf
//   usaa          https://www.usaa.com/favicon.svg
//   wholefoods    https://www.wholefoodsmarket.com/ header logo, the leaf O
//                 that the site favicon shows
//   whoop*        https://developer.whoop.com/docs/developing/design-guidelines
//   ynab          https://www.ynab.com/press, Tree Logo
// A connector with no legitimately available mark is listed here and declares
// no `brand`, so consumers fall back to the monogram instead of an invented logo.
const CONNECTORS_WITHOUT_A_BRAND_MARK = new Set([]);

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

test("every declared brand icon is a self-contained, intentionally inked SVG mark", () => {
  for (const filename of manifestFiles()) {
    const { path, manifest } = readManifest(filename);
    if (manifest.brand === undefined) continue;
    for (const field of ["icon", "dark_icon"]) {
      if (manifest.brand[field] === undefined) continue;
      const iconPath = join(dirname(path), manifest.brand[field]);
      assertSafeRecognisableSvg(readFileSync(iconPath, "utf8"), iconPath);
    }
  }
});

test("every declared brand icon is a real brand mark, not a hand-drawn glyph", () => {
  // Every connector without a confidently-sourced brand mark declares none
  // (see CONNECTORS_WITHOUT_A_BRAND_MARK above) rather than shipping a
  // placeholder, so no declared icon here needs an exemption. This guard
  // catches a future manifest whose `brand.icon` points at a hand-drawn glyph.
  for (const filename of manifestFiles()) {
    const { path, manifest } = readManifest(filename);
    if (manifest.brand === undefined) continue;
    const iconPath = join(dirname(path), manifest.brand.icon);
    assertRealBrandMarkShape(readFileSync(iconPath, "utf8"), iconPath);
  }
});
