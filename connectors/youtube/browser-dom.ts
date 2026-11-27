// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// DOM readers ported from the retained youtube-playwright.js at 862da2e0e0^.
// Each function runs unchanged in a browser page and in fixture DOM tests.

export interface BrowserVideo {
	video_id: string | null;
	video_url: string;
	video_title: string | null;
	channel_title: string | null;
	channel_url: string | null;
	duration_text: string | null;
	thumbnail_url: string | null;
	watched_date_label?: string | null;
	views_text?: string | null;
	description?: string | null;
}

export const CHANNEL_TITLE_SELECTOR = [
	"yt-page-header-view-model h1 span",
	".yt-page-header-view-model__page-header-title h1 span",
	"ytd-channel-name yt-formatted-string",
	"#channel-name yt-formatted-string",
	"h1#title",
	"h1 yt-formatted-string",
	"h1",
].join(", ");

export function readOwnAccount(doc: Document = document): {
	channel_url: string | null;
	email: string | null;
} {
	const header = doc.querySelector("ytd-active-account-header-renderer");
	if (!header) return { channel_url: null, email: null };
	const handle = header.querySelector("#channel-handle")?.textContent?.trim();
	const link = Array.from(
		header.querySelectorAll<HTMLAnchorElement>(
			'a[href*="/@"], a[href*="/channel/"]',
		),
	).find(
		(a) =>
			!/\/(edit|create|monetization)(?:[/?]|$)/.test(
				a.getAttribute("href") ?? "",
			),
	);
	const menuItem = Array.from(
		doc.querySelectorAll(
			"ytd-multi-page-menu-renderer ytd-compact-link-renderer",
		),
	).find((item) => {
		const label = item
			.querySelector("#label")
			?.textContent?.trim()
			.replace(/\s+/g, " ")
			.toLowerCase();
		const accessibleLink = item.querySelector<HTMLAnchorElement>(
			"a[aria-label], a[title]",
		);
		const accessibleLabel = (
			accessibleLink?.getAttribute("aria-label") ??
			accessibleLink?.getAttribute("title") ??
			""
		)
			.trim()
			.toLowerCase();
		return label === "your channel" || accessibleLabel === "your channel";
	});
	const menuLink = menuItem?.querySelector<HTMLAnchorElement>(
		'a[href*="/@"], a[href*="/channel/"]',
	);
	const href = handle?.startsWith("@")
		? `/${handle}`
		: (link?.getAttribute("href") ?? menuLink?.getAttribute("href"));
	const email =
		header.querySelector("#email, [id*='email']")?.textContent?.trim() || null;
	const url = href ? new URL(href, "https://www.youtube.com") : null;
	return {
		channel_url:
			url?.origin === "https://www.youtube.com" &&
			!/\/(edit|create|monetization|studio)(?:[/?]|$)/.test(url.pathname)
				? url.href
				: null,
		email,
	};
}

/**
 * Opens the avatar menu's "Switch account" view, where YouTube shows the
 * signed-in Google account's email. Resolves true only once the view's own
 * header is present, not merely after the click: the handler may sit on the
 * item renderer or on its nested endpoint anchor, so the anchor is clicked
 * (the event still bubbles to a renderer-level handler).
 */
export async function openSwitchAccount(
	doc: Document = document,
	timeoutMs = 4_000,
): Promise<boolean> {
	const item = Array.from(
		doc.querySelectorAll<HTMLElement>(
			"ytd-multi-page-menu-renderer ytd-compact-link-renderer",
		),
	).find(
		(candidate) =>
			candidate
				.querySelector("#label")
				?.textContent?.trim()
				.replace(/\s+/g, " ")
				.toLowerCase() === "switch account",
	);
	if (!item) return false;
	(item.querySelector<HTMLElement>("a#endpoint, #endpoint") ?? item).click();
	// Inline, no helper bindings: this reader is serialized into the page.
	const headerSelector = "ytd-google-account-header-renderer";
	if (doc.querySelector(headerSelector)) return true;
	const view = doc.defaultView;
	if (!view) return false;
	return new Promise<boolean>((resolve) => {
		const observer = new view.MutationObserver(() => {
			if (!doc.querySelector(headerSelector)) return;
			observer.disconnect();
			resolve(true);
		});
		observer.observe(doc, { childList: true, subtree: true });
		view.setTimeout(() => {
			observer.disconnect();
			resolve(doc.querySelector(headerSelector) !== null);
		}, timeoutMs);
	});
}

/**
 * The signed-in account's email from the Switch account view's own header.
 * Only that header is read: the account list below it names other accounts.
 */
export function readGoogleAccountEmail(doc: Document = document): string | null {
	const text = doc
		.querySelector("ytd-google-account-header-renderer #email")
		?.textContent?.trim();
	// Inline: these readers are serialized into the page without module scope.
	return text && /^[^\s@<>"']+@[^\s@<>"'.]+\.[^\s@<>"']+$/.test(text)
		? text
		: null;
}

export function readChannelPage(doc: Document = document): {
	channel_id: string | null;
	channel_url: string;
	title: string | null;
	handle: string | null;
	avatar_url: string | null;
} {
	const url = doc.location.href;
	const canonical =
		doc.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? url;
	const channel_id =
		/\/channel\/(UC[\w-]+)/.exec(canonical)?.[1] ??
		doc.querySelector<HTMLMetaElement>('meta[itemprop="channelId"]')?.content ??
		null;
	const handle = /\/@([^/?#]+)/.exec(url)?.[1];
	const title =
		Array.from(
			doc.querySelectorAll(
				[
					"yt-page-header-view-model h1 span",
					".yt-page-header-view-model__page-header-title h1 span",
					"ytd-channel-name yt-formatted-string",
					"#channel-name yt-formatted-string",
					"h1#title",
					"h1 yt-formatted-string",
					"h1",
				].join(", "),
			),
		)
			.map((node) => node.textContent?.trim() ?? "")
			.find(Boolean) ?? null;
	// YouTube sets an image's src only once it loads; until then `src` reads
	// "", which is not a URL. Inline: readers run in the page without imports.
	const avatarSrc = doc.querySelector<HTMLImageElement>(
		"yt-img-shadow#avatar img, #avatar img",
	)?.src;
	return {
		channel_id,
		channel_url: url,
		title,
		handle: handle ? `@${handle}` : null,
		avatar_url:
			avatarSrc && /^https?:\/\//i.test(avatarSrc) ? avatarSrc : null,
	};
}

export function readChannelAbout(doc: Document = document): {
	joined_at: string | null;
	description: string | null;
	country: string | null;
	subscriber_count_text: string | null;
	view_count_text: string | null;
	video_count_text: string | null;
} {
	const about = doc.querySelector(
		"ytd-channel-about-metadata-renderer, yt-about-this-channel-renderer",
	);
	const aboutRoot = about ?? doc;
	const statsRoot = about;
	const text = Array.from(
		aboutRoot.querySelectorAll("yt-formatted-string, span, td, dd"),
	)
		.filter((node) => node.children.length === 0)
		.map((node) => node.textContent?.trim() ?? "");
	const statsText = statsRoot
		? Array.from(
				statsRoot.querySelectorAll("yt-formatted-string, span, td, dd"),
			)
				.filter((node) => node.children.length === 0)
				.map((node) => node.textContent?.trim() ?? "")
		: [];
	const joined = text.find((value) => /^joined\s+/i.test(value));
	const country =
		about?.querySelector('[id*="country"]')?.textContent?.trim() || null;
	return {
		joined_at: joined?.replace(/^joined\s+/i, "") ?? null,
		description:
			aboutRoot
				.querySelector(
					"#description-container yt-formatted-string, #description yt-formatted-string, #description",
				)
				?.textContent?.trim() || null,
		country,
		subscriber_count_text:
			statsText.find(
				(value) => /subscriber/i.test(value) && /\d/.test(value),
			) ?? null,
		view_count_text:
			statsText.find((value) => /view/i.test(value) && /\d/.test(value)) ??
			null,
		video_count_text:
			statsText.find((value) => /video/i.test(value) && /\d/.test(value)) ??
			null,
	};
}

export function readSubscriptions(doc: Document = document): Array<{
	channel_url: string;
	channel_title: string;
	channel_id: string | null;
	handle: string | null;
	avatar_url: string | null;
	description: string | null;
	is_verified: boolean | null;
	notifications: boolean | null;
	subscriber_count_text?: string;
}> {
	return Array.from(doc.querySelectorAll("ytd-channel-renderer"))
		.flatMap((node) => {
			const title = node
				.querySelector(
					"ytd-channel-name#channel-title yt-formatted-string#text, ytd-channel-name yt-formatted-string#text, ytd-channel-name yt-formatted-string",
				)
				?.textContent?.trim();
			const href = node
				.querySelector<HTMLAnchorElement>(
					'#main-link, a[href*="/@"], a[href*="/channel/"]',
				)
				?.getAttribute("href");
			if (!title || !href) return [];
			const url = new URL(href, "https://www.youtube.com");
			if (url.origin !== "https://www.youtube.com") return [];
			const badgeArea = node.querySelector("ytd-channel-name");
			const bell = node.querySelector<HTMLButtonElement>(
				'ytd-subscription-notification-toggle-button-renderer-next button, [aria-label*="All notifications"], yt-button-shape[aria-label*="notification"] button, [aria-label*="notifications"]',
			);
			const bellLabel = bell?.getAttribute("aria-label")?.toLowerCase() ?? "";
			const subscriberCountText = node
				.querySelector("#metadata span#video-count")
				?.textContent?.trim();
			// An avatar that has not loaded has no src and reads "": not a URL.
			const avatarSrc = node.querySelector<HTMLImageElement>(
				"yt-img-shadow img, img#img",
			)?.src;
			return [
				{
					channel_url: url.href,
					channel_title: title,
					channel_id: /\/channel\/(UC[\w-]+)/.exec(href)?.[1] ?? null,
					handle: /\/@([^/?#]+)/.exec(href)?.[1]
						? `@${/\/@([^/?#]+)/.exec(href)?.[1]}`
						: null,
					avatar_url:
						avatarSrc && /^https?:\/\//i.test(avatarSrc) ? avatarSrc : null,
					description:
						node
							.querySelector("yt-formatted-string#description")
							?.textContent?.trim() || null,
					...(subscriberCountText
						? { subscriber_count_text: subscriberCountText }
						: {}),
					is_verified: badgeArea
						? Boolean(
								badgeArea.querySelector(
									"badge-shape, .badge-shape, ytd-badge-supported-renderer badge-shape",
								),
							)
						: null,
					notifications: /all notifications/.test(bellLabel)
						? true
						: /(?:personalized|none) notifications/.test(bellLabel)
							? false
							: null,
				},
			];
		});
}

export function readPlaylistLinks(
	doc: Document = document,
): Array<{ id: string; url: string }> {
	const seen = new Set<string>();
	const playlistCards = Array.from(
		doc.querySelectorAll(
			"ytd-playlist-renderer, ytd-grid-playlist-renderer, ytd-compact-playlist-renderer, yt-lockup-view-model",
		),
	);
	const links = playlistCards.length
		? playlistCards.flatMap((card) => {
				const link = Array.from(
					card.querySelectorAll<HTMLAnchorElement>('a[href*="list="]'),
				).find((anchor) => {
					const url = new URL(
						anchor.getAttribute("href") ?? "",
						"https://www.youtube.com",
					);
					return (
						url.origin === "https://www.youtube.com" &&
						url.pathname === "/playlist" &&
						Boolean(url.searchParams.get("list"))
					);
				});
				if (!link) return [];
				if (
					card.matches("yt-lockup-view-model") &&
					!card.querySelector("yt-collection-thumbnail-view-model")
				)
					return [];
				return [link];
			})
		: Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href*="list="]'));
	return links
		.flatMap((a) => {
			const url = new URL(
				a.getAttribute("href") ?? "",
				"https://www.youtube.com",
			);
			if (
				url.origin !== "https://www.youtube.com" ||
				url.pathname !== "/playlist"
			)
				return [];
			const id = url.searchParams.get("list");
			if (!id || id === "LL" || id === "WL" || seen.has(id)) return [];
			seen.add(id);
			return [{ id, url: url.href }];
		});
}

export function readPlaylistHeader(doc: Document = document): {
	title: string | null;
	owner: string | null;
	owner_url: string | null;
	visibility: string | null;
	video_count_text: string | null;
	view_count_text: string | null;
} {
	const owner = doc.querySelector<HTMLAnchorElement>(
		"yt-avatar-stack-view-model a",
	);
	const meta = Array.from(
		doc.querySelectorAll(".yt-content-metadata-view-model__metadata-text"),
	).map((node) => node.textContent?.trim() ?? "");
	return {
		title:
			doc
				.querySelector(
					"yt-dynamic-text-view-model h1 span, .yt-page-header-view-model__page-header-title h1 span, h1#title, h1 yt-formatted-string",
				)
				?.textContent?.trim() || null,
		owner: owner?.textContent?.trim().replace(/^by\s+/i, "") || null,
		owner_url: owner?.getAttribute("href")
			? new URL(owner.getAttribute("href")!, "https://www.youtube.com").href
			: null,
		visibility:
			meta.find((s) => /^(public|private|unlisted)$/i.test(s)) ?? null,
		video_count_text:
			meta.find((s) => /\d/.test(s) && /video/i.test(s)) ?? null,
		view_count_text: meta.find((s) => /view/i.test(s)) ?? null,
	};
}

export interface HistoryVideoPage {
	readonly offset: number;
	readonly totalRows: number;
	readonly rows: readonly (BrowserVideo | null)[];
}

interface HistoryVideoPageRequest {
	readonly mode: "history";
	readonly offset: number;
	readonly limit: number;
}

export function readVideos(
	mode: "playlist" | "history",
	doc?: Document,
): BrowserVideo[];
export function readVideos(request: HistoryVideoPageRequest): HistoryVideoPage;
export function readVideos(
	modeOrRequest: "playlist" | "history" | HistoryVideoPageRequest,
	doc: Document = document,
): BrowserVideo[] | HistoryVideoPage {
	const pageRequest = typeof modeOrRequest === "object" ? modeOrRequest : null;
	const mode: "playlist" | "history" = pageRequest
		? pageRequest.mode
		: (modeOrRequest as "playlist" | "history");
	const source = pageRequest ? document : doc;
	const groups: Array<{ root: ParentNode; label: string | null }> =
		mode === "history"
			? Array.from(source.querySelectorAll("ytd-item-section-renderer")).map(
					(root) => ({
						root,
						label:
							root
								.querySelector(
									"ytd-item-section-header-renderer #header #title, #header #title",
								)
								?.textContent?.trim() || null,
					}),
				)
			: [{ root: source, label: null }];
	const nodeGroups = groups.map(({ root, label }) => {
		const nodes =
			mode === "history"
				? Array.from(
						root.querySelectorAll("yt-lockup-view-model, ytd-video-renderer"),
					).filter(
						(node) =>
							!node.matches("ytd-video-renderer") ||
							!node.querySelector("yt-lockup-view-model"),
					)
				: root.querySelectorAll(
						"yt-lockup-view-model, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer",
					);
		return { nodes, label };
	});
	const totalRows = nodeGroups.reduce(
		(count, group) => count + group.nodes.length,
		0,
	);
	const first = pageRequest ? Math.max(0, pageRequest.offset) : 0;
	const last = pageRequest
		? Math.min(totalRows, first + Math.max(1, pageRequest.limit))
		: totalRows;
	const result: Array<BrowserVideo | null> = [];
	for (let globalIndex = first; globalIndex < last; globalIndex += 1) {
		let localIndex = globalIndex;
		let node: Element | null = null;
		let label: string | null = null;
		for (const group of nodeGroups) {
			if (localIndex < group.nodes.length) {
				node = group.nodes[localIndex] ?? null;
				label = group.label;
				break;
			}
			localIndex -= group.nodes.length;
		}
		if (!node) {
			if (pageRequest) result.push(null);
			continue;
		}
		const link = node.querySelector<HTMLAnchorElement>(
			'a.yt-lockup-view-model__content-image, a.ytLockupViewModelContentImage, a.yt-lockup-metadata-view-model__title, a.ytLockupMetadataViewModelTitle, a[href*="/watch?"], a[href*="/shorts/"]',
		);
		const href = link?.getAttribute("href");
		if (!href) {
			if (pageRequest) result.push(null);
			continue;
		}
		const video_url = new URL(href, "https://www.youtube.com").href;
		if (new URL(video_url).origin !== "https://www.youtube.com") {
			if (pageRequest) result.push(null);
			continue;
		}
		const contentHost = (node.getAttribute("class") ?? "").includes(
			"content-id-",
		)
			? node
			: node.querySelector('[class*="content-id-"]');
		const classId = Array.from(contentHost?.classList ?? [])
			.find((name) => name.startsWith("content-id-"))
			?.slice(11);
		const video_id =
			classId ||
			new URL(video_url).searchParams.get("v") ||
			/\/shorts\/([\w-]+)/.exec(video_url)?.[1] ||
			null;
		const titleNode = node.querySelector(
			"h3.yt-lockup-metadata-view-model__heading-reset, h3.ytLockupMetadataViewModelHeadingReset, h3, #video-title, a#video-title span, span#video-title, a#video-title yt-formatted-string",
		);
		const video_title =
			titleNode?.getAttribute("title")?.trim() ||
			titleNode?.textContent?.trim() ||
			null;
		const channelLink = node.querySelector<HTMLAnchorElement>(
			'a[href*="/@"], a[href*="/channel/"]',
		);
		const avatar = node.querySelector('[aria-label^="Go to channel"]');
		const spans = Array.from(
			node.querySelectorAll(
				".yt-content-metadata-view-model__metadata-text, .ytContentMetadataViewModelMetadataText",
			),
		);
		const channel_title =
			avatar
				?.getAttribute("aria-label")
				?.replace(/^Go to channel\s+/i, "")
				.trim() ||
			node
				.querySelector("ytd-channel-name a, #channel-name a")
				?.textContent?.trim() ||
			spans[0]?.textContent?.trim() ||
			null;
		// A lazy thumbnail has no src (reads "") or a data: placeholder until it
		// nears the viewport; neither is the video's thumbnail URL.
		const thumbnailSrc = node.querySelector<HTMLImageElement>(
			"img.yt-core-image, ytd-thumbnail img, img#img",
		)?.src;
		const views_text =
			spans
				.findLast((s) => /view/i.test(s.textContent ?? ""))
				?.textContent?.trim() || null;
		result.push({
			video_id,
			video_url,
			video_title,
			channel_title,
			channel_url: channelLink?.getAttribute("href")
				? new URL(channelLink.getAttribute("href")!, "https://www.youtube.com")
						.href
				: null,
			duration_text:
				node
					.querySelector(
						"ytd-thumbnail-overlay-time-status-renderer span, .ytBadgeShapeText, .badge-shape-wiz__text",
					)
					?.textContent?.trim() || null,
			thumbnail_url:
				thumbnailSrc && /^https?:\/\//i.test(thumbnailSrc)
					? thumbnailSrc
					: null,
			watched_date_label: label,
			views_text,
			description:
				node
					.querySelector(
						".yt-content-metadata-view-model__metadata-text-max-lines-2, .ytContentMetadataViewModelMetadataTextMaxLines2",
					)
					?.textContent?.trim() || null,
		});
	}
	return pageRequest
		? { offset: first, totalRows, rows: result }
		: result.filter((video): video is BrowserVideo => video !== null);
}
