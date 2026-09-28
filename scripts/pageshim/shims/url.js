// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// `url` subset (harmless shim).
export const fileURLToPath = (u) =>
	decodeURIComponent(new URL(String(u)).pathname);
export const pathToFileURL = (p) => new URL(`file://${encodeURI(p)}`);
const _URL = globalThis.URL;
const _USP = globalThis.URLSearchParams;

export { _URL as URL, _USP as URLSearchParams };
export default {
	fileURLToPath,
	pathToFileURL,
	URL: _URL,
	URLSearchParams: _USP,
};
