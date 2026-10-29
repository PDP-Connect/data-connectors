// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { parseHTML } from "linkedom";
import { z } from "zod";
import { hasOrdersEmptyState } from "./parsers.ts";
import type { ProfileRecord } from "./types.ts";

/** Server-rendered account responses are scoped to the browser's authenticated
 * session. The logout control and SSR route must agree; a public shell or an
 * unrelated embedded object is not account evidence. No provider owner ID is
 * invented for the orders response, which does not expose one. */
function accountPageProps(html: string, route: string): unknown {
	const { document } = parseHTML(html);
	if (!document.querySelector('a[href="/oidc/session/end"]')) return null;
	const raw = document.querySelector("script#__NEXT_DATA__")?.textContent;
	if (!raw) return null;
	try {
		const result = z
			.object({
				page: z.literal(route),
				gssp: z.literal(true),
				props: z.object({ __N_SSP: z.literal(true), pageProps: z.unknown() }),
			})
			.safeParse(JSON.parse(raw));
		return result.success ? result.data.props.pageProps : null;
	} catch {
		return null;
	}
}

const text = z.string().trim().min(1);
const profileSource = z.object({
	profileId: text,
	profile: z.object({
		firstName: text,
		lastName: text,
		email: z.email(),
		daytimeTelephoneNumber: text.nullable(),
	}),
	addresses: z.array(
		z.object({
			id: text,
			nickname: z.string().nullable(),
			address1: text,
			address2: z.string().nullable(),
			city: text,
			state: text,
			postalCode: text,
			defaultAddress: z.boolean(),
		}),
	),
});

/** The profile and complete address array are delivered in one SSR response.
 * Reject the aggregate if any address or primary marker cannot be read. */
export function parseAccountProfile(html: string): ProfileRecord | null {
	const result = profileSource.safeParse(
		accountPageProps(html, "/my-account/profile"),
	);
	if (!result.success) return null;
	const { profile, addresses } = result.data;
	if (new Set(addresses.map((a) => a.id)).size !== addresses.length)
		return null;
	return {
		id: "profile",
		name: `${profile.firstName} ${profile.lastName}`,
		email: profile.email,
		phone: profile.daytimeTelephoneNumber,
		delivery_addresses: addresses.map((a) => ({
			address: [a.address1, a.address2, `${a.city}, ${a.state} ${a.postalCode}`]
				.filter(Boolean)
				.join(", "),
			label: a.nickname,
			is_primary: a.defaultAddress,
		})),
	};
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
