// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Read a file that a signed-in site serves, from inside its own page.
 *
 * Two operations, both through `page.evaluate` only, so the same code runs on
 * the Desktop Playwright page and on the Mobile PageShim page facade
 * (scripts/pageshim/runtime.ts). Neither one observes network traffic.
 *
 * - `fetchSameOriginFile`: `fetch()` a same-origin URL with the page's
 *   cookies and return the body as text or base64. This is the
 *   `same_origin_page_fetch` binding feature.
 * - `armDownloadCapture` + `waitForDownloadIntent`: while armed, the page's
 *   own download actions are recorded instead of performed: a form
 *   submission the page does not cancel (also from inside an open shadow
 *   root), `window.open`, a hidden frame's `src`, or a click on a link with a
 *   `download` attribute or a `blob:`/`data:` URL. For a `blob:` or
 *   `data:` link the file content is kept (the site built it in the page, so
 *   there is no URL to fetch). For the other kinds the connector gets the
 *   request the site would have made and fetches it with
 *   `fetchSameOriginFile`.
 *
 * The capture replaces page globals (`HTMLFormElement.prototype.submit`,
 * `HTMLAnchorElement.prototype.click`, `URL.createObjectURL`, `window.open`,
 * the frame `src` setter) and adds a capture-phase click listener and
 * bubble-phase submit listeners. Call
 * `disarmDownloadCapture` when done; a navigation also discards it.
 */

/** The one page member this module calls. Playwright's `Page` and the PageShim facade both have it. */
export interface EvaluatingPage {
	evaluate: <R, A>(fn: (arg: A) => R | Promise<R>, arg: A) => Promise<R>;
}

export interface SameOriginFile {
	ok: boolean;
	status: number;
	contentType: string;
	contentDisposition: string;
	byteLength: number;
	text?: string;
	base64?: string;
	/** Set when no HTTP response was read: bad_url, cross_origin, too_large or fetch_failed:<message>. */
	error?: string;
}

export interface SameOriginFetchOptions {
	as: "text" | "base64";
	method?: "GET" | "POST";
	body?: string;
	headers?: Record<string, string>;
	maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/** Fetch a same-origin URL inside the page with the page's credentials. */
export function fetchSameOriginFile(
	page: EvaluatingPage,
	url: string,
	options: SameOriginFetchOptions,
): Promise<SameOriginFile> {
	return page.evaluate(
		async (arg: {
			url: string;
			as: "text" | "base64";
			method: string;
			body: string | null;
			headers: Record<string, string>;
			maxBytes: number;
		}): Promise<SameOriginFile> => {
			const fail = (error: string, status = 0): SameOriginFile => ({
				ok: false,
				status,
				contentType: "",
				contentDisposition: "",
				byteLength: 0,
				error,
			});
			let target: URL;
			try {
				target = new URL(arg.url, location.href);
			} catch {
				return fail("bad_url");
			}
			if (target.origin !== location.origin) {
				return fail("cross_origin");
			}
			try {
				const response = await fetch(target.href, {
					method: arg.method,
					credentials: "include",
					headers: arg.headers,
					...(arg.body === null ? {} : { body: arg.body }),
				});
				const buffer = await response.arrayBuffer();
				const head: SameOriginFile = {
					ok: response.ok,
					status: response.status,
					contentType: response.headers.get("content-type") ?? "",
					contentDisposition: response.headers.get("content-disposition") ?? "",
					byteLength: buffer.byteLength,
				};
				if (buffer.byteLength > arg.maxBytes) {
					return { ...head, ok: false, error: "too_large" };
				}
				if (arg.as === "text") {
					return { ...head, text: new TextDecoder().decode(buffer) };
				}
				const bytes = new Uint8Array(buffer);
				let binary = "";
				for (let offset = 0; offset < bytes.length; offset += 0x8000) {
					binary += String.fromCharCode(
						...bytes.subarray(offset, offset + 0x8000),
					);
				}
				return { ...head, base64: btoa(binary) };
			} catch (error) {
				return fail(
					`fetch_failed: ${String((error as Error)?.message ?? error).slice(0, 200)}`,
				);
			}
		},
		{
			url,
			as: options.as,
			method: options.method ?? "GET",
			body: options.body ?? null,
			headers: options.headers ?? {},
			maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
		},
	);
}

/** A download the page tried to start while the capture was armed. */
export type DownloadIntent =
	| {
			kind: "form";
			method: string;
			action: string;
			fields: [string, string][];
	  }
	| {
			kind: "link";
			/** The link URL; `blob:` and `data:` links keep only the scheme. */
			url: string;
			filename: string | null;
			/** The file a `blob:` or `data:` link carried, as a data URL. */
			dataUrl?: string;
			error?: string;
	  }
	| { kind: "open"; url: string }
	| { kind: "frame"; url: string };

const CAPTURE_KEY = "__pdppDownloadCapture";

/** Start recording the page's download actions. Clears earlier intents. */
export function armDownloadCapture(page: EvaluatingPage): Promise<boolean> {
	return page.evaluate((key: string): boolean => {
		type Intent = Record<string, unknown>;
		type Store = {
			intents: Intent[];
			pending: number;
			restore: () => void;
		};
		const host = window as unknown as Record<string, Store | undefined>;
		const existing = host[key];
		if (existing) {
			existing.intents.length = 0;
			return true;
		}
		const store: Store = { intents: [], pending: 0, restore: () => undefined };
		host[key] = store;
		const blobs = new Map<string, Blob>();

		const originalCreateObjectURL = URL.createObjectURL;
		URL.createObjectURL = (object: Blob | MediaSource): string => {
			const url = originalCreateObjectURL.call(URL, object);
			if (object instanceof Blob) {
				blobs.set(url, object);
			}
			return url;
		};
		const readBlob = (blob: Blob): Promise<string> =>
			new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result));
				reader.onerror = () => reject(reader.error);
				reader.readAsDataURL(blob);
			});
		const recordLink = (anchor: HTMLAnchorElement): boolean => {
			const href = anchor.href;
			const filename = anchor.getAttribute("download");
			const isBlob = href.startsWith("blob:");
			const isData = href.startsWith("data:");
			if (filename === null && !isBlob && !isData) {
				return false;
			}
			const intent: Intent = {
				kind: "link",
				url: isBlob ? "blob:" : isData ? "data:" : href,
				filename,
			};
			if (isData) {
				intent.dataUrl = href;
			} else if (isBlob) {
				const blob = blobs.get(href);
				if (blob) {
					store.pending += 1;
					readBlob(blob)
						.then((dataUrl) => {
							intent.dataUrl = dataUrl;
						})
						.catch((error: unknown) => {
							intent.error = `blob_read_failed: ${String(error)}`;
						})
						.finally(() => {
							store.pending -= 1;
						});
				} else {
					intent.error = "blob_not_retained";
				}
			}
			store.intents.push(intent);
			return true;
		};
		const recordForm = (
			form: HTMLFormElement,
			submitter?: HTMLElement | null,
		): void => {
			let data: FormData;
			try {
				data = submitter ? new FormData(form, submitter) : new FormData(form);
			} catch {
				data = new FormData(form);
			}
			const fields: [string, string][] = [];
			for (const [name, value] of data.entries()) {
				fields.push([name, typeof value === "string" ? value : ""]);
			}
			store.intents.push({
				kind: "form",
				method: (form.getAttribute("method") || "GET").toUpperCase(),
				action: form.action || location.href,
				fields,
			});
		};

		const originalAnchorClick = HTMLAnchorElement.prototype.click;
		HTMLAnchorElement.prototype.click = function click(
			this: HTMLAnchorElement,
		) {
			if (recordLink(this)) {
				return;
			}
			originalAnchorClick.call(this);
		};
		// A form submission is a download intent only when the page lets it
		// navigate: the page's own submit handlers run first, and a page that
		// cancels the submission (to build the file in the page, say) is left
		// alone. So the decision is taken in a bubble-phase listener on the
		// last node the event reaches: `window`, or the shadow root of a form
		// inside one (a `submit` event does not leave its shadow root).
		const onLateSubmit = (event: Event): void => {
			if (
				event.defaultPrevented ||
				!(event.target instanceof HTMLFormElement)
			) {
				return;
			}
			recordForm(event.target, (event as SubmitEvent).submitter);
			event.preventDefault();
		};
		const shadowRoots: ShadowRoot[] = [];
		const onClick = (event: Event): void => {
			// composedPath() also sees elements inside open shadow roots.
			for (const node of event.composedPath()) {
				if (node instanceof HTMLAnchorElement) {
					if (recordLink(node)) event.preventDefault();
					return;
				}
				if (
					(node instanceof HTMLButtonElement ||
						node instanceof HTMLInputElement) &&
					node.type === "submit" &&
					node.form
				) {
					const root = node.form.getRootNode();
					if (root instanceof ShadowRoot && !shadowRoots.includes(root)) {
						shadowRoots.push(root);
						root.addEventListener("submit", onLateSubmit);
					}
					return;
				}
			}
		};
		document.addEventListener("click", onClick, true);
		window.addEventListener("submit", onLateSubmit);
		// `form.submit()` navigates without a submit event.
		const originalSubmit = HTMLFormElement.prototype.submit;
		HTMLFormElement.prototype.submit = function submit(this: HTMLFormElement) {
			recordForm(this);
		};
		const originalOpen = window.open;
		// Return a window-like object, not null: some sites (chase.com) call
		// `window.open("", "_self")` and submit their download form only when
		// that returns a window. The object does nothing, so nothing navigates.
		window.open = (url?: string | URL, target?: string): Window => {
			store.intents.push({
				kind: "open",
				url: new URL(String(url ?? ""), location.href).href,
			});
			const noop = (): void => undefined;
			const opened = {
				closed: false,
				name: target ?? "",
				opener: window,
				location: { href: "about:blank" },
				document: { open: noop, write: noop, writeln: noop, close: noop },
				focus: noop,
				blur: noop,
				postMessage: noop,
				close: (): void => {
					opened.closed = true;
				},
			};
			return opened as unknown as Window;
		};
		const frameSrc = Object.getOwnPropertyDescriptor(
			HTMLIFrameElement.prototype,
			"src",
		);
		if (frameSrc?.set) {
			Object.defineProperty(HTMLIFrameElement.prototype, "src", {
				...frameSrc,
				set(value: string) {
					store.intents.push({
						kind: "frame",
						url: new URL(String(value), location.href).href,
					});
				},
			});
		}
		store.restore = () => {
			URL.createObjectURL = originalCreateObjectURL;
			HTMLAnchorElement.prototype.click = originalAnchorClick;
			HTMLFormElement.prototype.submit = originalSubmit;
			window.open = originalOpen;
			if (frameSrc) {
				Object.defineProperty(HTMLIFrameElement.prototype, "src", frameSrc);
			}
			document.removeEventListener("click", onClick, true);
			window.removeEventListener("submit", onLateSubmit);
			for (const root of shadowRoots) {
				root.removeEventListener("submit", onLateSubmit);
			}
			delete host[key];
		};
		return true;
	}, CAPTURE_KEY);
}

/** Restore the page globals `armDownloadCapture` replaced. */
export async function disarmDownloadCapture(
	page: EvaluatingPage,
): Promise<void> {
	await page
		.evaluate((key: string): boolean => {
			const host = window as unknown as Record<
				string,
				{ restore: () => void } | undefined
			>;
			host[key]?.restore();
			return true;
		}, CAPTURE_KEY)
		.catch((): undefined => undefined);
}

/**
 * Wait for the first recorded download intent. Returns null when none came in
 * `timeoutMs`, or when the capture is gone (the page navigated away).
 */
export async function waitForDownloadIntent(
	page: EvaluatingPage,
	{
		timeoutMs,
		pollMs = 250,
		sleep = (ms: number) =>
			new Promise<void>((resolve) => setTimeout(resolve, ms)),
	}: {
		timeoutMs: number;
		pollMs?: number;
		sleep?: (ms: number) => Promise<void>;
	},
): Promise<DownloadIntent | null> {
	const started = Date.now();
	for (;;) {
		const intent = await page.evaluate(
			(key: string): DownloadIntent | "gone" | null => {
				const store = (
					window as unknown as Record<
						string,
						{ intents: DownloadIntent[]; pending: number } | undefined
					>
				)[key];
				if (!store) {
					return "gone";
				}
				if (store.pending > 0 || store.intents.length === 0) {
					return null;
				}
				return store.intents.shift() ?? null;
			},
			CAPTURE_KEY,
		);
		if (intent === "gone") {
			return null;
		}
		if (intent) {
			return intent;
		}
		if (Date.now() - started >= timeoutMs) {
			return null;
		}
		await sleep(pollMs);
	}
}

/** Build the GET URL a form intent would have navigated to. */
export function formIntentUrl(
	intent: Extract<DownloadIntent, { kind: "form" }>,
	overrides: Record<string, string> = {},
): string {
	const url = new URL(intent.action);
	const params = new URLSearchParams();
	const seen = new Set<string>();
	for (const [name, value] of intent.fields) {
		if (name in overrides) {
			if (!seen.has(name)) {
				params.append(name, overrides[name] as string);
			}
		} else {
			params.append(name, value);
		}
		seen.add(name);
	}
	for (const [name, value] of Object.entries(overrides)) {
		if (!seen.has(name)) {
			params.append(name, value);
		}
	}
	url.search = params.toString();
	return url.href;
}

/** Decode a `data:` URL to its media type and bytes. Throws on a malformed URL. */
export function decodeDataUrl(dataUrl: string): {
	mediaType: string;
	bytes: Uint8Array;
} {
	const comma = dataUrl.indexOf(",");
	if (!dataUrl.startsWith("data:") || comma < 0) {
		throw new Error("not a data URL");
	}
	const meta = dataUrl.slice(5, comma);
	const payload = dataUrl.slice(comma + 1);
	const isBase64 = /;base64$/i.test(meta);
	const mediaType = (isBase64 ? meta.slice(0, -7) : meta) || "text/plain";
	if (isBase64) {
		const binary = atob(payload);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}
		return { mediaType, bytes };
	}
	return {
		mediaType,
		bytes: new TextEncoder().encode(decodeURIComponent(payload)),
	};
}
