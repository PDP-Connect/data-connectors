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
		doc.querySelectorAll("ytd-multi-page-menu-renderer ytd-compact-link-renderer"),
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
		: link?.getAttribute("href") ?? menuLink?.getAttribute("href");
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
	return {
		channel_id,
		channel_url: url,
		title:
			doc
				.querySelector(
					"ytd-channel-name yt-formatted-string, #channel-name yt-formatted-string, h1",
				)
				?.textContent?.trim() || null,
		handle: handle ? `@${handle}` : null,
		avatar_url:
			doc.querySelector<HTMLImageElement>(
				"yt-img-shadow#avatar img, #avatar img",
			)?.src ?? null,
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
	const text = Array.from(
		about?.querySelectorAll("yt-formatted-string, span, td, dd") ?? [],
	)
		.filter((node) => node.children.length === 0)
		.map((node) => node.textContent?.trim() ?? "");
	const joined = text.find((value) => /^joined\s+/i.test(value));
	const country =
		about
			?.querySelector('[id*="country"]')
			?.textContent?.trim() || null;
	return {
		joined_at: joined?.replace(/^joined\s+/i, "") ?? null,
		description:
			about
				?.querySelector(
					"#description-container yt-formatted-string, #description yt-formatted-string, #description",
				)
				?.textContent?.trim() || null,
		country,
		subscriber_count_text:
			text.find((value) => /subscriber/i.test(value) && /\d/.test(value)) ??
			null,
		view_count_text:
			text.find((value) => /view/i.test(value) && /\d/.test(value)) ?? null,
		video_count_text:
			text.find((value) => /video/i.test(value) && /\d/.test(value)) ?? null,
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
	subscriber_count_text: string | null;
}> {
	return Array.from(doc.querySelectorAll("ytd-channel-renderer"))
		.flatMap((node) => {
			const title = node
				.querySelector(
					"ytd-channel-name yt-formatted-string#text, ytd-channel-name yt-formatted-string",
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
				'ytd-subscription-notification-toggle-button-renderer-next button, [aria-label*="notifications"]',
			);
			const bellLabel = bell?.getAttribute("aria-label")?.toLowerCase() ?? "";
			return [
				{
					channel_url: url.href,
					channel_title: title,
					channel_id: /\/channel\/(UC[\w-]+)/.exec(href)?.[1] ?? null,
					handle: /\/@([^/?#]+)/.exec(href)?.[1]
						? `@${/\/@([^/?#]+)/.exec(href)?.[1]}`
						: null,
					avatar_url:
						node.querySelector<HTMLImageElement>("yt-img-shadow img, img#img")
							?.src ?? null,
					description:
						node
							.querySelector("yt-formatted-string#description")
							?.textContent?.trim() || null,
					subscriber_count_text:
						node
							.querySelector("#metadata span#video-count")
							?.textContent?.trim() || null,
					is_verified: badgeArea
						? Boolean(badgeArea.querySelector("badge-shape, .badge-shape"))
						: null,
					notifications: /all notifications/.test(bellLabel)
						? true
						: /(?:personalized|none) notifications/.test(bellLabel)
							? false
							: null,
				},
			];
		})
		.slice(0, 20);
}

export function readPlaylistLinks(
	doc: Document = document,
): Array<{ id: string; url: string }> {
	const seen = new Set<string>();
	const links = Array.from(
		doc.querySelectorAll<HTMLAnchorElement>('a[href*="playlist?list="]'),
	);
	return links
		.flatMap((a) => {
			const url = new URL(
				a.getAttribute("href") ?? "",
				"https://www.youtube.com",
			);
			if (url.origin !== "https://www.youtube.com") return [];
			const id = url.searchParams.get("list");
			if (!id || id === "LL" || id === "WL" || seen.has(id)) return [];
			seen.add(id);
			return [{ id, url: url.href }];
		})
		.slice(0, 50);
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

export function readVideos(
	mode: "playlist" | "history",
	doc: Document = document,
): BrowserVideo[] {
	const groups: Array<{ root: ParentNode; label: string | null }> =
		mode === "history"
			? Array.from(doc.querySelectorAll("ytd-item-section-renderer")).map(
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
			: [{ root: doc, label: null }];
	const result: BrowserVideo[] = [];
	for (const { root, label } of groups) {
		const nodes =
			mode === "history"
				? root.querySelectorAll("yt-lockup-view-model")
				: root.querySelectorAll(
						"yt-lockup-view-model, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer",
					);
		for (const node of nodes) {
			const link = node.querySelector<HTMLAnchorElement>(
				'a.yt-lockup-view-model__content-image, a.ytLockupViewModelContentImage, a.yt-lockup-metadata-view-model__title, a.ytLockupMetadataViewModelTitle, a[href*="/watch?"], a[href*="/shorts/"]',
			);
			const href = link?.getAttribute("href");
			if (!href) continue;
			const video_url = new URL(href, "https://www.youtube.com").href;
			if (new URL(video_url).origin !== "https://www.youtube.com") continue;
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
				"h3.yt-lockup-metadata-view-model__heading-reset, h3.ytLockupMetadataViewModelHeadingReset, h3, #video-title",
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
					? new URL(
							channelLink.getAttribute("href")!,
							"https://www.youtube.com",
						).href
					: null,
				duration_text:
					node
						.querySelector(
							"ytd-thumbnail-overlay-time-status-renderer span, .ytBadgeShapeText, .badge-shape-wiz__text",
						)
						?.textContent?.trim() || null,
				thumbnail_url:
					node.querySelector<HTMLImageElement>(
						"img.yt-core-image, ytd-thumbnail img, img#img",
					)?.src ?? null,
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
	}
	return result;
}
