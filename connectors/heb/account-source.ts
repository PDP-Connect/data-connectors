// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { parseHTML } from "linkedom";
import { z } from "zod";
import { hasOrdersEmptyState } from "./parsers.ts";
import type { ProfileRecord } from "./types.ts";

/** Server-rendered account responses are scoped to the browser's authenticated
 * session. A signed-in-only control and the SSR route must agree; a public
 * shell or an unrelated embedded object is not account evidence. No provider
 * owner ID is invented for the orders response, which does not expose one.
 *
 * The control is per page. H-E-B no longer renders a sign-out link
 * (/oidc/session/end) in either page's initial markup (live capture,
 * 2026-11-18): the profile page carries its account-edit controls
 * (/oidc/prompt/edit_account), and the orders page carries its results
 * container, the same evidence the run-start session probe trusts. */
const SIGNED_IN_CONTROL: Record<string, string> = {
	"/my-account/profile": 'a[href^="/oidc/prompt/edit_account"]',
	"/my-account/your-orders": '[data-qe-id="orderResults"]',
	// The order's summary card (subtotal, tax, payment method), live 2026-11-18.
	"/my-account/order-history/[orderId]": '[data-qe-id="orderSummaryCard"]',
};
type ProfileReadFailure = {
	gate: "signed_out_marker" | "next_data_missing" | "next_data_unparseable"
		| "ssr_route_mismatch" | "schema" | "duplicate_address_id";
	issue_paths: string[];
};

function readAccountPageProps(html: string, route: string): {
	props: unknown;
	failure: ProfileReadFailure | null;
} {
	const { document } = parseHTML(html);
	const control = SIGNED_IN_CONTROL[route];
	if (!control || !document.querySelector(control))
		return { props: null, failure: { gate: "signed_out_marker", issue_paths: [] } };
	const raw = document.querySelector("script#__NEXT_DATA__")?.textContent;
	if (!raw) return { props: null, failure: { gate: "next_data_missing", issue_paths: [] } };
	try {
		const result = z
			.object({
				page: z.literal(route),
				gssp: z.literal(true),
				props: z.object({ __N_SSP: z.literal(true), pageProps: z.unknown() }),
			})
			.safeParse(JSON.parse(raw));
		return result.success
			? { props: result.data.props.pageProps, failure: null }
			: { props: null, failure: { gate: "ssr_route_mismatch", issue_paths: [] } };
	} catch {
		return { props: null, failure: { gate: "next_data_unparseable", issue_paths: [] } };
	}
}

function accountPageProps(html: string, route: string): unknown {
	return readAccountPageProps(html, route).props;
}

const text = z.string().trim().min(1);
/** A part of a saved address H-E-B may leave out: absent, null or blank reads as null. */
const addressPart = z.string().trim().nullish().transform((value) => value || null);
const profileSource = z.object({
	profileId: text,
	profile: z.object({
		firstName: text,
		lastName: text,
		email: z.email(),
		daytimeTelephoneNumber: z.string().trim().nullish().transform((value) => value || null),
	}),
	addresses: z.array(
		z.object({
			id: text,
			nickname: z.string().nullish().transform((value) => value ?? null),
			address1: addressPart,
			address2: addressPart,
			city: addressPart,
			state: addressPart,
			postalCode: addressPart,
			defaultAddress: z.boolean(),
		}),
	),
});

/** The profile and complete address array are delivered in one SSR response.
 * Reject the aggregate if any address id or primary marker cannot be read, or a
 * part has the wrong type. H-E-B keeps saved addresses with parts left out
 * (seen live 2026-11-18): such an address keeps the parts it has, and one with
 * no street, city, state or postal code holds no address and is left out. */
export function readAccountProfile(html: string): {
	record: ProfileRecord | null;
	failure: ProfileReadFailure | null;
} {
	const page = readAccountPageProps(html, "/my-account/profile");
	if (page.failure) return { record: null, failure: page.failure };
	const result = profileSource.safeParse(page.props);
	if (!result.success) return {
		record: null,
		failure: { gate: "schema", issue_paths: result.error.issues.map((issue) => issue.path.join(".")) },
	};
	const { profile, addresses } = result.data;
	if (new Set(addresses.map((a) => a.id)).size !== addresses.length)
		return { record: null, failure: { gate: "duplicate_address_id", issue_paths: [] } };
	const record: ProfileRecord = {
		id: "profile",
		name: `${profile.firstName} ${profile.lastName}`,
		email: profile.email,
		phone: profile.daytimeTelephoneNumber,
		delivery_addresses: addresses.flatMap((a) => {
			const region = [a.state, a.postalCode].filter(Boolean).join(" ");
			const address = [a.address1, a.address2, a.city, region].filter(Boolean).join(", ");
			return address ? [{ address, label: a.nickname, is_primary: a.defaultAddress }] : [];
		}),
	};
	return { record, failure: null };
}

export function parseAccountProfile(html: string): ProfileRecord | null {
	return readAccountProfile(html).record;
}

const orderDetailSource = z.object({
	order: z.object({ orderId: text, orderItems: z.array(z.object({})) }),
});

/** The number of item lines in this order's server-rendered payload
 * (pageProps.order.orderItems; it matched the rendered rows on every order
 * captured live on 2026-11-18). Null unless the page is the signed-in
 * session's server response for exactly the requested order. */
export function sourceOrderItemTotal(html: string, orderId: string): number | null {
	const result = orderDetailSource.safeParse(
		accountPageProps(html, "/my-account/order-history/[orderId]"),
	);
	return result.success && result.data.order.orderId === orderId
		? result.data.order.orderItems.length
		: null;
}

export interface SourceOrderItem {
	/** Null only for an item H-E-B serves with no product id and no name. */
	productId: string | null;
	/** Product ids of the item's substitutes, from `subbedProducts[]` as `id`
	 * or `product.id`; an element in any other shape adds no id. */
	substituteIds: string[];
	/** Null when H-E-B leaves the name out; such an item cannot match by text. It
	 * becomes a nameless record only through the line-total pairing in
	 * parsers.ts (namelessRecords). */
	fullDisplayName: string | null;
	/** The SSR `productPageURL` when it is an www.heb.com product-detail page
	 * ending in this product id; otherwise null. */
	productUrl: string | null;
	/** Null when H-E-B leaves it out or writes it as anything but a number. */
	quantity: number | null;
	/** The item's `totalLineItemPricePaid.formattedAmount` when it is a
	 * non-blank string; the key that pairs a nameless item with its line. */
	lineTotal: string | null;
	/** Only when fullDisplayName is null: whether any non-blank string sits
	 * under a key that could carry a name, link or image, at any depth. */
	naming?: "none" | "found" | "incomplete";
	/** With naming "found": the leaf's path, written in a fixed alphabet. */
	namingPath?: string;
}

/** Keys that could carry a name, link or image of an item. */
const NAMING_KEY_RE = /image|img|photo|picture|url|href|name|title|label|desc/i;
const NAMING_SCAN_MAX_NODES = 200_000;
const NAMING_SCAN_MAX_DEPTH = 256;
/** Subtrees of `product` that name nothing: a category is not a product name
 * and an image URL does not name the product it shows. `__typename` is a type
 * tag at any depth. Every other key, SKUs and unknown ones included, keeps the veto. */
const NAMING_SKIPPED_PRODUCT_KEYS = new Set(["productCategory", "productImageUrls", "thumbnailImageUrls"]);
/** The only key text a held trace may print: H-E-B's own known keys. Any other
 * segment prints as `?`, so source text never reaches the trace. */
const NAMING_PATH_VOCABULARY = new Set([
	"SKUs", "__typename", "bestAvailable", "fullDisplayName", "id", "isEbtSnapProduct", "maximumOrderQuantity",
	"minimumOrderQuantity", "productCategory", "productImageUrls", "productPageURL", "shoppingContext", "storeId",
	"thumbnailImageUrls", "customerFriendlySize", "weightSelectionIncrements", "twelveDigitUPC", "contextPrices",
	"product", "url", "name", "displayName", "title", "description",
]);

function namingPathText(path: readonly (string | number)[]): string {
	return path.map((part) => (typeof part === "number" ? "#" : NAMING_PATH_VOCABULARY.has(part) ? part : "?")).join(".");
}

/** A complete walk of one raw item, with no leaf cap: "found" at the first
 * non-blank string under a naming key (the key itself or any ancestor key),
 * with the leaf's path in the fixed alphabet; "incomplete" when the walk
 * exceeds its node or depth bound. */
function namingScan(raw: unknown): { naming: "none" | "incomplete" } | { naming: "found"; path: string } {
	const stack: [unknown, boolean, (string | number)[]][] = [[raw, false, []]];
	let nodes = 0;
	while (stack.length > 0) {
		const [value, under, path] = stack.pop()!;
		if (++nodes > NAMING_SCAN_MAX_NODES || path.length > NAMING_SCAN_MAX_DEPTH) return { naming: "incomplete" };
		if (typeof value === "string") {
			if (under && value.trim()) return { naming: "found", path: namingPathText(path) };
		} else if (Array.isArray(value)) {
			value.forEach((element, index) => stack.push([element, under, [...path, index]]));
		} else if (value !== null && typeof value === "object") {
			for (const [key, element] of Object.entries(value)) {
				if (key === "__typename" || (path.length === 1 && path[0] === "product" && NAMING_SKIPPED_PRODUCT_KEYS.has(key))) continue;
				stack.push([element, under || NAMING_KEY_RE.test(key), [...path, key]]);
			}
		}
	}
	return { naming: "none" };
}

function namingFacts(raw: unknown): { naming: "none" | "found" | "incomplete"; namingPath?: string } {
	const scan = namingScan(raw);
	return "path" in scan ? { naming: scan.naming, namingPath: scan.path } : { naming: scan.naming };
}

function productPageUrl(value: string | null | undefined, productId: string): string | null {
	if (!value) return null;
	try {
		const url = new URL(value, "https://www.heb.com");
		const last = url.pathname.split("/").filter(Boolean).pop();
		return url.protocol === "https:" && url.hostname === "www.heb.com" &&
			url.pathname.startsWith("/product-detail/") && last === productId
			? url.href
			: null;
	} catch {
		return null;
	}
}

/** A product id H-E-B may write as a string or a whole number. */
const productIdText = z.union([text, z.number().int().nonnegative().transform(String)]);

const substituteId = z.union([
	z.object({ id: productIdText }).transform((sub) => sub.id),
	z.object({ product: z.object({ id: productIdText }) }).transform((sub) => sub.product.id),
]);

function namedAmount(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Each SSR orderItem of this order (none when the payload is missing, names
 * another order, or any item lacks a product id), and the payload's shape for
 * diagnostics: the item count, or why it was not read. Never ids or names. */
export function readSourceOrderItems(
	html: string,
	orderId: string,
): { items: SourceOrderItem[]; shape: string } {
	const props = accountPageProps(html, "/my-account/order-history/[orderId]");
	const result = z.object({ order: z.object({
		orderId: text,
		orderItems: z.array(z.object({
			// An item with no name may also have no product id (or no product).
			product: z.object({
				id: productIdText.nullish().or(z.literal("")),
				fullDisplayName: z.string().trim().nullish(),
				productPageURL: z.string().nullish(),
			}).nullish(),
			quantity: z.unknown().optional(),
			subbedProducts: z.array(z.unknown()).nullish(),
			totalLineItemPricePaid: z.object({ formattedAmount: z.unknown().optional() }).nullish(),
		})),
	}) }).safeParse(props);
	if (!result.success) {
		const issue = result.error.issues[0];
		const path = issue?.path.map((part) => (typeof part === "number" ? "#" : String(part))).join(".");
		return { items: [], shape: issue ? `unread:${path}:${issue.code}` : "unread" };
	}
	if (result.data.order.orderId !== orderId) return { items: [], shape: "unread:other_order" };
	const rawItems = (props as { order: { orderItems: unknown[] } }).order.orderItems;
	// An item that names itself must carry its product id.
	const idless = result.data.order.orderItems.findIndex(
		(item) => !item.product?.id && item.product?.fullDisplayName,
	);
	if (idless !== -1) return { items: [], shape: "unread:order.orderItems.#.product.id:invalid_union" };
	const items = result.data.order.orderItems.map((item, index) => ({
		productId: item.product?.id || null,
		substituteIds: (item.subbedProducts ?? []).flatMap((sub) => {
			const id = substituteId.safeParse(sub);
			return id.success ? [id.data] : [];
		}),
		fullDisplayName: item.product?.fullDisplayName || null,
		productUrl: item.product?.id
			? productPageUrl(item.product.productPageURL, item.product.id)
			: null,
		quantity:
			typeof item.quantity === "number" && Number.isFinite(item.quantity) && item.quantity >= 0
				? item.quantity
				: null,
		lineTotal: namedAmount(item.totalLineItemPricePaid?.formattedAmount),
		...(item.product?.fullDisplayName ? {} : namingFacts(rawItems[index])),
	}));
	const quantityTypes = [...new Set(result.data.order.orderItems.map((item) => typeof item.quantity))].sort();
	return { items, shape: `${items.length},qty:${quantityTypes.join("|") || "none"}` };
}

const emptyHistorySource = z.object({
	orders: z.array(z.unknown()).length(0),
	page: z.literal(1),
	pages: z.array(z.unknown()).length(0),
	errorMessage: z.null(),
});

/** Both the first-page server payload and the rendered results affirm no
 * retained orders. Empty markup, later pages, source errors and partial
 * pagination never establish this proof. */
export function sourceReportsEmptyHistory(html: string): boolean {
	if (
		!emptyHistorySource.safeParse(
			accountPageProps(html, "/my-account/your-orders"),
		).success ||
		!hasOrdersEmptyState(html)
	)
		return false;
	const { document } = parseHTML(html);
	// Empty SSR metadata cannot override a rendered continuation or page control.
	if (
		document.querySelector('nav[aria-label*="Pagination" i], a[rel~="next" i]')
	)
		return false;
	const ordersUrl = "https://www.heb.com/my-account/your-orders";
	return [...document.querySelectorAll("a[href]")].every((link) => {
		try {
			const url = new URL(link.getAttribute("href") ?? "", ordersUrl);
			return (
				url.origin !== "https://www.heb.com" ||
				url.pathname !== "/my-account/your-orders" ||
				!url.searchParams.has("page") ||
				url.searchParams.get("page") === "1"
			);
		} catch {
			return false;
		}
	});
}
