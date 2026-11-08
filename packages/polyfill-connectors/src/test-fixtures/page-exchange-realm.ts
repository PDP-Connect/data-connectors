// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A fake page for tests of in-page capture scripts. Each document is a fresh
// node:vm realm with just enough of a browser: location, fetch,
// XMLHttpRequest and the body types. `navigate` replaces the document and
// runs the registered init scripts first, as a host with page_init_script
// does. The "app" is the test: it sends requests through the realm's own
// (wrapped) fetch and XMLHttpRequest.

import vm from "node:vm";

export class FakeXhr {
	private readonly listeners: Array<() => void> = [];
	method = "";
	url = "";
	sent: unknown = undefined;
	headers: Array<[string, string]> = [];
	responseText = "";
	responseType = "";
	response: unknown = null;
	status = 0;
	addEventListener(type: string, listener: () => void): void {
		if (type === "loadend") this.listeners.push(listener);
	}
	open(method: string, url: string): void {
		this.method = method;
		this.url = url;
	}
	setRequestHeader(name: string, value: string): void {
		this.headers.push([name, value]);
	}
	send(body: unknown): void {
		this.sent = body;
	}
	/** Complete the request: a text body, or a value for responseType json/arraybuffer. */
	finish(status: number, body: string, responseType = ""): void {
		this.status = status;
		this.responseType = responseType;
		if (responseType === "json") this.response = JSON.parse(body) as unknown;
		else if (responseType === "arraybuffer")
			this.response = new TextEncoder().encode(body).buffer;
		else this.responseText = body;
		for (const listener of this.listeners) listener();
	}
	fail(): void {
		this.status = 0;
		for (const listener of this.listeners) listener();
	}
}

export type FetchHandler = (
	url: string,
	init: { method?: string; body?: unknown } | undefined,
) => Promise<Response>;

export interface FakeDocument {
	readonly realm: vm.Context;
	readonly url: string;
	run(code: string): unknown;
	/** The realm's (possibly wrapped) fetch. */
	fetch(input: unknown, init?: unknown): Promise<Response>;
	/** A new XMLHttpRequest from the realm's (possibly wrapped) prototype. */
	xhr(
		method: string,
		url: string,
		body?: unknown,
		headers?: Array<[string, string]>,
	): FakeXhr;
}

export interface FakePage {
	/** The current document. */
	readonly document: FakeDocument;
	readonly initScripts: string[];
	readonly calls: string[];
	evaluate(code: string): Promise<unknown>;
	addInitScript?: (source: string) => Promise<void>;
	/** Load a new document at `url`; init scripts run before `beforeApp`. */
	navigate(
		url: string,
		beforeApp?: (document: FakeDocument) => void,
	): FakeDocument;
	/** Let pending promise work (body reads, record calls) finish. */
	settle(): Promise<void>;
}

function createDocument(href: string, onFetch: FetchHandler): FakeDocument {
	const url = new URL(href);
	class RealmXhr extends FakeXhr {}
	const sandbox: Record<string, unknown> = {
		location: {
			href: url.href,
			origin: url.origin,
			hostname: url.hostname,
			pathname: url.pathname,
		},
		XMLHttpRequest: RealmXhr,
		fetch: (input: unknown, init?: { method?: string; body?: unknown }) => {
			const target = input instanceof Request ? input.url : String(input);
			return onFetch(new URL(target, url.href).href, init);
		},
		URL,
		URLSearchParams,
		FormData,
		Blob,
		Request,
		Response,
		Headers,
		TextDecoder,
		TextEncoder,
		ArrayBuffer,
		ReadableStream,
		Promise,
		JSON,
		Date,
		Math,
		String,
		Number,
		Object,
		Array,
		Set,
		Map,
		WeakMap,
		RegExp,
	};
	const realm = vm.createContext(sandbox);
	sandbox.window = realm;
	sandbox.top = realm;
	const run = (code: string): unknown => vm.runInContext(code, realm);
	return {
		realm,
		url: url.href,
		run,
		fetch: (input, init) =>
			(realm.fetch as (input: unknown, init?: unknown) => Promise<Response>)(
				input,
				init,
			),
		xhr: (method, target, body, headers = []) => {
			const request = new (realm.XMLHttpRequest as typeof FakeXhr)();
			request.open(method, target);
			for (const [name, value] of headers)
				request.setRequestHeader(name, value);
			request.send(body);
			return request;
		},
	};
}

/** Values from the vm realm carry its prototypes; compare them as plain JSON. */
export const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * How a host treats `page.addInitScript(source)`: `refuse` returns why it
 * rejects the call (null to accept), `wrap` gives the source it installs.
 */
export interface FakeInitScriptHost {
	refuse?: (
		source: string,
		installed: { count: number; bytes: number },
	) => string | null;
	wrap?: (source: string) => string;
}

export function createFakePage(
	options: {
		url?: string;
		/**
		 * `true`: the host runs init scripts. `"unsupported"`: the host has the
		 * member but rejects every call, as a device without document-start
		 * scripts does. Absent: the host has no `addInitScript`.
		 */
		initScripts?: boolean | "unsupported";
		initScriptHost?: FakeInitScriptHost;
		onFetch?: FetchHandler;
	} = {},
): FakePage {
	const onFetch: FetchHandler =
		options.onFetch ??
		(async () => {
			throw new Error("no fetch handler");
		});
	const initScripts: string[] = [];
	const calls: string[] = [];
	let document = createDocument(options.url ?? "https://app.example/", onFetch);
	const page: FakePage = {
		get document() {
			return document;
		},
		initScripts,
		calls,
		evaluate: async (code: string) => {
			calls.push("evaluate");
			// A host returns plain JSON values.
			const value = document.run(code);
			return value === undefined ? null : plain(value);
		},
		navigate: (url, beforeApp) => {
			calls.push(`navigate ${url}`);
			document = createDocument(url, onFetch);
			for (const source of initScripts) document.run(source);
			beforeApp?.(document);
			return document;
		},
		settle: async () => {
			for (let tick = 0; tick < 20; tick += 1)
				await new Promise((resolve) => setImmediate(resolve));
		},
	};
	if (options.initScripts === "unsupported") {
		page.addInitScript = async () => {
			calls.push("addInitScript");
			throw new Error("page.addInitScript is not supported by this host");
		};
	} else if (options.initScripts) {
		let bytes = 0;
		page.addInitScript = async (source: string) => {
			calls.push("addInitScript");
			const refusal = options.initScriptHost?.refuse?.(source, {
				count: initScripts.length,
				bytes,
			});
			if (refusal) throw new Error(refusal);
			bytes += Buffer.byteLength(source, "utf8");
			initScripts.push(options.initScriptHost?.wrap?.(source) ?? source);
		};
	}
	return page;
}
