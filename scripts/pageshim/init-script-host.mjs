// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// What the Mobile host does with a `page.addInitScript(source)` call, so the
// harness can run connector init scripts under the same rules. A port of
// vana-com/unity-surfaces apps/mobile-shell/lib/connect/provider_user_scripts.dart
// and js_source_guard.dart (PR #2173). Keep it in step with those files.
//
// - The source is refused, never truncated, when it is not a string, is over
//   64 KiB (UTF-8), would be the run's 17th script or push the run past
//   256 KiB, or when its brackets, strings or comments do not balance.
// - An accepted source is wrapped in a labelled block, so a top-level `var`
//   or function reaches `window` but a top-level `let`, `const` or `class`
//   stays local, and a leading 'use strict' is not a directive.
// - The wrapper runs the source only in the main frame and only on the row's
//   cookieDomain host and its subdomains.

export const PAGE_INIT_SCRIPT_MAX_BYTES = 64 * 1024;
export const PAGE_INIT_SCRIPT_MAX_COUNT = 16;
export const PAGE_INIT_SCRIPT_MAX_TOTAL_BYTES = 256 * 1024;

/** The rejection text of a host without document-start scripts. */
export const PAGE_INIT_SCRIPT_UNSUPPORTED =
	"page.addInitScript is not supported by this host: this device's WebView cannot run scripts at document start";

/** `.instagram.com` → `instagram.com`; null when the value cannot be a host. */
export function providerHostForCookieDomain(cookieDomain) {
	const host = String(cookieDomain).trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
	return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) ? host : null;
}

const REGEX_KEYWORDS = new Set([
	"return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
	"case", "do", "else", "yield", "await", "throw",
]);
const isWordChar = (c) => /^[0-9A-Za-z$_]$/.test(c);

/**
 * "ok", or why the source could escape a block it is wrapped in:
 * "unbalancedClose", "unbalancedOpen" or "unterminated".
 */
export function inspectWrappability(source) {
	const stack = [];
	const templateDepths = [];
	let i = 0;
	const n = source.length;
	let previous = "";
	let previousWord = "";
	const regexAllowedHere = () => {
		if (previous === "") return true;
		if (previousWord !== "") return REGEX_KEYWORDS.has(previousWord);
		return "([{,;:=!&|?+-*%~^<>".includes(previous);
	};
	const scanQuoted = (quote) => {
		while (i < n) {
			const c = source[i];
			if (c === "\\") {
				i += 2;
				continue;
			}
			if (c === quote) {
				i += 1;
				return true;
			}
			if (c === "\n" || c === "\r") return false;
			i += 1;
		}
		return false;
	};
	while (i < n) {
		const c = source[i];
		if (templateDepths.length > 0 && stack.length === templateDepths.at(-1)) {
			let resolved = false;
			while (i < n) {
				const t = source[i];
				if (t === "\\") {
					i += 2;
					continue;
				}
				if (t === "`") {
					i += 1;
					templateDepths.pop();
					previous = "`";
					previousWord = "";
					resolved = true;
					break;
				}
				if (t === "$" && source[i + 1] === "{") {
					i += 2;
					stack.push("{");
					previous = "{";
					previousWord = "";
					resolved = true;
					break;
				}
				i += 1;
			}
			if (!resolved) return "unterminated";
			continue;
		}
		if (c === "/" && source[i + 1] === "/") {
			i += 2;
			while (i < n && source[i] !== "\n" && source[i] !== "\r") i += 1;
			continue;
		}
		if (c === "/" && source[i + 1] === "*") {
			i += 2;
			let closed = false;
			while (i + 1 < n) {
				if (source[i] === "*" && source[i + 1] === "/") {
					i += 2;
					closed = true;
					break;
				}
				i += 1;
			}
			if (!closed) return "unterminated";
			continue;
		}
		if (c === "/" && regexAllowedHere()) {
			i += 1;
			let inClass = false;
			let closed = false;
			while (i < n) {
				const r = source[i];
				if (r === "\\") {
					i += 2;
					continue;
				}
				if (r === "\n" || r === "\r") break;
				if (r === "[") inClass = true;
				if (r === "]") inClass = false;
				if (r === "/" && !inClass) {
					i += 1;
					closed = true;
					break;
				}
				i += 1;
			}
			if (!closed) return "unterminated";
			while (i < n && isWordChar(source[i])) i += 1;
			previous = "/";
			previousWord = "";
			continue;
		}
		if (c === "'" || c === '"') {
			i += 1;
			if (!scanQuoted(c)) return "unterminated";
			previous = c;
			previousWord = "";
			continue;
		}
		if (c === "`") {
			i += 1;
			templateDepths.push(stack.length);
			continue;
		}
		if (c === "(" || c === "[" || c === "{") {
			stack.push(c);
			previous = c;
			previousWord = "";
			i += 1;
			continue;
		}
		if (c === ")" || c === "]" || c === "}") {
			if (stack.length === 0) return "unbalancedClose";
			const expected = c === ")" ? "(" : c === "]" ? "[" : "{";
			if (stack.pop() !== expected) return "unbalancedClose";
			previous = c;
			previousWord = "";
			i += 1;
			continue;
		}
		if (isWordChar(c)) {
			const start = i;
			while (i < n && isWordChar(source[i])) i += 1;
			previousWord = source.slice(start, i);
			previous = previousWord.at(-1);
			continue;
		}
		if (c.trim() === "") {
			i += 1;
			continue;
		}
		previous = c;
		previousWord = "";
		i += 1;
	}
	if (templateDepths.length > 0) return "unterminated";
	if (stack.length > 0) return "unbalancedOpen";
	return "ok";
}

/**
 * Why the host refuses `page.addInitScript(source)`, or null when it accepts.
 * `installed` is what the run already added: `{ count, bytes }`.
 */
export function pageInitScriptRefusal(source, installed) {
	if (typeof source !== "string") return "page.addInitScript expects the script source as a string";
	const bytes = Buffer.byteLength(source, "utf8");
	if (bytes > PAGE_INIT_SCRIPT_MAX_BYTES)
		return `page.addInitScript refused a ${bytes}-byte script; the limit is ${PAGE_INIT_SCRIPT_MAX_BYTES} bytes`;
	if (installed.count >= PAGE_INIT_SCRIPT_MAX_COUNT)
		return `page.addInitScript refused: a run may add at most ${PAGE_INIT_SCRIPT_MAX_COUNT} scripts`;
	if (installed.bytes + bytes > PAGE_INIT_SCRIPT_MAX_TOTAL_BYTES)
		return `page.addInitScript refused: the run's init scripts would pass ${PAGE_INIT_SCRIPT_MAX_TOTAL_BYTES} bytes`;
	const verdict = inspectWrappability(source);
	if (verdict !== "ok")
		return `page.addInitScript refused the script (${verdict}): its brackets, strings or comments do not balance, so it cannot be bound to the provider origin`;
	return null;
}

const HOST_GUARD_TEMPLATE = `
  var __vanaHosts = /*__VANA_HOSTS__*/;
  var __vanaAllowed = false;
  try {
    var __vanaHost = String(location.hostname || '').toLowerCase();
    for (var __vi = 0; __vi < __vanaHosts.length; __vi++) {
      var __vd = __vanaHosts[__vi];
      if (__vanaHost === __vd) { __vanaAllowed = true; break; }
      if (__vanaHost.length > __vd.length + 1 &&
          __vanaHost.slice(-(__vd.length + 1)) === '.' + __vd) {
        __vanaAllowed = true;
        break;
      }
    }
  } catch (e) { __vanaAllowed = false; }
  if (!__vanaAllowed) return;
`;

const WRAPPER_TEMPLATE = `
__vanaPageInitScript: {
if (window.top !== window) break __vanaPageInitScript;
if (!(function () {
/*__VANA_HOST_GUARD__*/
  return true;
})()) break __vanaPageInitScript;
/*__VANA_INIT_SCRIPT__*/
}
`;

/** The source the host installs for an accepted `page.addInitScript(source)`. */
export function wrapPageInitScript(hosts, source) {
	const guard = HOST_GUARD_TEMPLATE.replace("/*__VANA_HOSTS__*/", () => JSON.stringify(hosts));
	return WRAPPER_TEMPLATE.replace("/*__VANA_HOST_GUARD__*/", () => guard).replace(
		"/*__VANA_INIT_SCRIPT__*/",
		() => source,
	);
}
