// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * In-page evidence that a YouTube list is empty, or that its enumeration has
 * reached the source's own end.
 *
 * The page-side code lives in one string. Playwright serializes functions with
 * `toString()`, and tsx rewrites nested helpers with a `__name` call that does
 * not exist in the page. Building the functions from a string avoids both that
 * and a second copy of the logic for tests.
 */

export type PageReadiness = "content" | "empty" | false;

/** The list a page enumerates. It decides which end evidence applies. */
export type ListKind =
	| "history"
	| "playlist"
	| "playlist-index"
	| "subscriptions";

export interface ListEndRequest {
	readonly kind: ListKind;
	/** The page-local session probe is false when auth was lost after navigation. */
	readonly sessionPresent?: boolean;
	/** Latest completed history-list response observed during this traversal. */
	readonly latestHistoryResponse?: HistoryResponseEvidence | null;
}

export interface HistoryResponseEvidence {
	readonly recognized: boolean;
	readonly hasContinuation: boolean;
	readonly itemCount?: number;
	/** Total entries added by correlated continuation responses so far. */
	readonly continuationItemCount?: number;
	readonly requestedContinuation: string | null;
	readonly nextContinuation: string | null;
	readonly repeatedContinuation: boolean;
}

export interface ListEnd {
	/** The target page's own `ytInitialData` list region held recognized entries. */
	readonly dataReadable: boolean;
	/** Items in that region at page load. */
	readonly dataItemCount: number;
	/** That region had a next-page continuation at page load. */
	readonly dataHasContinuation: boolean;
	/** Bounded continuation tokens from the selected history list at page load. */
	readonly historyBootstrapContinuationTokens?: readonly string[];
	/** Recognized entry count inside that selected history list. */
	readonly historyBootstrapItemCount?: number;
	readonly historyBootstrapRendererCounts?: Readonly<Record<string, number>>;
	/** The rendered page still shows a next-page continuation. */
	readonly domHasContinuation: boolean;
	/** The "N videos" total the page header declares (playlist pages only). */
	readonly declaredTotal: number | null;
	/** Rendered items before the connector's own row limit (kinds with one). */
	readonly domItemCount: number | null;
	/** The target list's own rendered end marker is present. */
	readonly domHasEndMarker: boolean;
	/** The target page data explicitly says the list is empty. */
	readonly verifiedEmpty: boolean;
	/**
	 * The page cannot show the target list: the session is lost, a sign-in,
	 * consent or error wall shows, the page or its data is still loading, the
	 * page is not the target route, or the page data holds a rejected message.
	 * It vetoes every kind of end evidence.
	 */
	readonly pageBlocked: boolean;
	/** Latest target-list response; bootstrap page data is not terminal evidence. */
	readonly latestHistoryResponse: HistoryResponseEvidence | null;
}

type UnknownObject = Record<string, unknown>;

function asObject(value: unknown): UnknownObject | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as UnknownObject)
		: null;
}

/** Extract continuation facts from one response already correlated to history. */
export function readHistoryResponseEvidence(
	value: unknown,
	requestedContinuation: string | null,
	previouslyRequested: ReadonlySet<string>,
): HistoryResponseEvidence {
	const tokens = new Set<string>();
	let recognized = false;
	let hasContinuation = false;
	let itemCount = 0;
	let bounded = true;
	let visited = 0;
	const visit = (node: unknown): void => {
		visited += 1;
		if (visited > 10000) {
			bounded = false;
			return;
		}
		if (Array.isArray(node)) {
			for (const child of node) {
				if (!bounded) break;
				visit(child);
			}
			return;
		}
		const object = asObject(node);
		if (!object) return;
		for (const [key, child] of Object.entries(object)) {
			if (ITEM_KEYS_FOR_HISTORY.has(key)) itemCount += 1;
			if (
				key === "appendContinuationItemsAction" ||
				key === "reloadContinuationItemsCommand" ||
				key === "twoColumnBrowseResultsRenderer" ||
				key === "singleColumnBrowseResultsRenderer"
			)
				recognized = true;
			if (key === "continuationItemRenderer" && asObject(child)) {
				hasContinuation = true;
				const renderer = asObject(child);
				const endpoint = asObject(renderer?.continuationEndpoint);
				const command = asObject(endpoint?.continuationCommand);
				const direct = asObject(renderer?.continuationCommand);
				const token =
					typeof command?.token === "string"
						? command.token
						: typeof direct?.token === "string"
							? direct.token
							: null;
				if (token && token.length <= 4096) tokens.add(token);
				else bounded = false;
			}
			if (key === "nextContinuationData") {
				hasContinuation = true;
				const continuation = asObject(child)?.continuation;
				if (
					typeof continuation === "string" &&
					continuation.length > 0 &&
					continuation.length <= 4096
				)
					tokens.add(continuation);
				else bounded = false;
			}
			if (key === "continuations" && Array.isArray(child) && child.length > 0) {
				recognized = true;
				hasContinuation = true;
			}
			visit(child);
			if (!bounded) break;
		}
	};
	visit(value);
	if (tokens.size > 8) bounded = false;
	const nextContinuation = tokens.values().next().value ?? null;
	return {
		recognized: recognized && bounded,
		hasContinuation,
		itemCount,
		requestedContinuation,
		nextContinuation,
		repeatedContinuation:
			nextContinuation !== null && previouslyRequested.has(nextContinuation),
	};
}

const ITEM_KEYS_FOR_HISTORY = new Set([
	"videoRenderer",
	"gridVideoRenderer",
	"playlistVideoRenderer",
	"playlistPanelVideoRenderer",
	"compactVideoRenderer",
	"videoWithContextRenderer",
	"richItemRenderer",
	"lockupViewModel",
	"shortsLockupViewModel",
	"reelItemRenderer",
]);

/**
 * True only when the source proves exhaustion: a verified empty list has no
 * rows, a readable list has no data or DOM continuation and all source entries
 * were read, a followed continuation disappeared, or the page showed an
 * explicit end marker. A blocked page vetoes all of these. Missing controls,
 * mismatched totals and row growth alone are not evidence.
 */
export function enumerationEnded(
	end: ListEnd | null | undefined,
	renderedCount: number,
	continuationFollowed = false,
	discardedRows = 0,
): boolean {
	if (!end || end.pageBlocked !== false) return false;
	const latestHistoryResponse = end.latestHistoryResponse;
	const historyResponseIsCurrent = latestHistoryResponse?.recognized === true;
	if (historyResponseIsCurrent && latestHistoryResponse.repeatedContinuation)
		return false;
	const dataHasContinuation = historyResponseIsCurrent
		? latestHistoryResponse.hasContinuation
		: end.dataHasContinuation;
	const historySourceItemCount =
		end.dataItemCount + (latestHistoryResponse?.continuationItemCount ?? 0);
	const knownRowsExceedEmitted =
		(end.domItemCount !== null && end.domItemCount > renderedCount) ||
		(end.dataReadable && historySourceItemCount > renderedCount);
	const renderedRowsMissingFromData =
		!historyResponseIsCurrent &&
		end.dataReadable &&
		end.domItemCount !== null &&
		end.domItemCount > end.dataItemCount;
	const declaredMismatch =
		!historyResponseIsCurrent &&
		end.declaredTotal !== null &&
		end.declaredTotal !== renderedCount;
	if (
		discardedRows > 0 ||
		(!historyResponseIsCurrent && end.domHasContinuation) ||
		dataHasContinuation ||
		knownRowsExceedEmitted ||
		renderedRowsMissingFromData ||
		(end.verifiedEmpty &&
			(renderedCount > 0 ||
				(end.domItemCount !== null && end.domItemCount > 0))) ||
		declaredMismatch
	)
		return false;
	if (historyResponseIsCurrent) return true;
	if (end.domHasEndMarker || continuationFollowed) return true;
	if (
		end.dataReadable &&
		!end.dataHasContinuation &&
		!end.domHasContinuation &&
		end.dataItemCount > 0 &&
		renderedCount >= end.dataItemCount &&
		(end.domItemCount === null || renderedCount >= end.domItemCount)
	)
		return true;
	if (end.verifiedEmpty) return renderedCount === 0;
	return false;
}

const PAGE_DATA_HELPERS = String.raw`
	const BASE = "https://www.youtube.com";
	const isObject = (value) => typeof value === "object" && value !== null;
	const textFragments = (value) => {
		if (typeof value === "string") return [value];
		if (!isObject(value)) return [];
		const out = [];
		const simpleText = value.simpleText;
		if (typeof simpleText === "string") out.push(simpleText);
		const text = value.text;
		if (isObject(text)) out.push(...textFragments(text));
		const runs = value.runs;
		if (Array.isArray(runs)) {
			for (const run of runs) {
				if (!isObject(run)) continue;
				const runText = run.text;
				if (typeof runText === "string") out.push(runText);
			}
		}
		return out;
	};
	const isRecognizedEmptyText = (text) =>
		/(?:no|empty|haven't|has no|doesn't have).*(?:video|playlist|history|subscription|channel)|nothing to show|no content/i.test(text) &&
		!/sign in|login|error|try again|unavailable|account|private|deleted|doesn't exist|not found/i.test(text);
	const playlistIdFromHref = (href) => {
		try {
			const url = new URL(href ?? "", BASE);
			const listId = url.searchParams.get("list");
			return url.origin === BASE && url.pathname === "/playlist" && listId ? listId : null;
		} catch {
			return null;
		}
	};
	const isEnumerablePlaylistLink = (anchor) => {
		const id = playlistIdFromHref(anchor.getAttribute("href"));
		return Boolean(id && id !== "LL" && id !== "WL");
	};
	const EMPTY_MESSAGE_KEYS = ["messageRenderer", "backgroundPromoRenderer", "ytdMessageRenderer", "ytdBackgroundPromoRenderer"];
	const LIST_KEYS = ["richGridRenderer", "gridRenderer", "playlistVideoListRenderer"];
	const ITEM_KEYS = [
		"videoRenderer", "gridVideoRenderer", "playlistVideoRenderer", "playlistPanelVideoRenderer",
		"compactVideoRenderer", "videoWithContextRenderer", "richItemRenderer", "lockupViewModel",
		"shortsLockupViewModel", "reelItemRenderer", "channelRenderer", "gridChannelRenderer",
		"gridPlaylistRenderer", "playlistRenderer", "compactPlaylistRenderer",
	];
	const isBuiltInLockup = (value) => {
		const find = (node) => {
			if (Array.isArray(node)) return node.some(find);
			if (!isObject(node)) return false;
			const lockup = isObject(node.lockupViewModel) ? node.lockupViewModel : node;
			if (typeof lockup.contentId === "string" && typeof lockup.contentType === "string") {
				const id = lockup.contentId;
			if ((id === "LL" || id === "WL") && /PLAYLIST/.test(lockup.contentType ?? "")) return true;
			}
			return Object.values(node).some(find);
		};
		return find(value);
	};
	const targetLocation = () => {
		try { return new URL(window.location.href); } catch { return null; }
	};
	const onPlaylistIndexPage = () => targetLocation()?.pathname === "/feed/playlists";
	const onPlaylistPage = () => {
		const url = targetLocation();
		return url?.pathname === "/playlist" && Boolean(url.searchParams.get("list"));
	};
	const onSubscriptionsPage = () => targetLocation()?.pathname === "/feed/channels";
	const onTargetRoute = (kind) => {
		const url = targetLocation();
		if (kind === "history") return url?.pathname === "/feed/history";
		if (kind === "playlist") return url?.pathname === "/playlist" && Boolean(url.searchParams.get("list"));
		if (kind === "playlist-index") return onPlaylistIndexPage();
		if (kind === "subscriptions") return onSubscriptionsPage();
		return false;
	};
	const isVisible = (node) => {
		if (node.closest('[hidden], [aria-hidden="true"]')) return false;
		const style = typeof window.getComputedStyle === "function" ? window.getComputedStyle(node) : null;
		if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) return false;
		return typeof node.getClientRects !== "function" || node.getClientRects().length > 0;
	};
	const hasVisibleMatch = (selector, root = document) => Array.from(root.querySelectorAll(selector)).some(isVisible);
	const hasPageWall = () => hasVisibleMatch(
		'a[href*="accounts.google.com/ServiceLogin"], ytd-consent-bump-v2-lightbox, ytd-consent-bump-v2, #consent-bump, tp-yt-paper-dialog[role="dialog"], ytd-popup-container tp-yt-paper-dialog, [aria-label*="sign in" i], #error-screen, ytd-error-screen, .yt-error-content, ytd-browse[page-subtype="error"]'
	);
	const hasDomLoading = (root = document) => {
		return hasVisibleMatch('.yt-spinner, yt-spinner, tp-yt-paper-spinner, tp-yt-paper-spinner-lite, [aria-busy="true"], [aria-label*="loading" i], #spinner', root);
	};
	const hasOnlyBuiltInPlaylistCards = () => {
		const cards = Array.from(document.querySelectorAll("yt-lockup-view-model, ytd-playlist-renderer, ytd-grid-playlist-renderer, ytd-compact-playlist-renderer"));
		return cards.length > 0 && cards.every((card) => {
			const id = Array.from(card.querySelectorAll('a[href*="list="]'))
				.map((anchor) => playlistIdFromHref(anchor.getAttribute("href")))
				.find(Boolean) ?? null;
			return (id === "LL" || id === "WL") &&
				(!card.matches("yt-lockup-view-model") || Boolean(card.querySelector("yt-collection-thumbnail-view-model")));
		});
	};
	const readJsonText = (scriptText) => {
		const markerIndex = scriptText.indexOf("ytInitialData");
		if (markerIndex < 0) return null;
		const start = scriptText.indexOf("{", markerIndex);
		if (start < 0) return null;
		let depth = 0;
		let quoted = false;
		let escaped = false;
		for (let index = start; index < scriptText.length; index += 1) {
			const char = scriptText[index];
			if (quoted) {
				if (escaped) escaped = false;
				else if (char === "\\") escaped = true;
				else if (char === '"') quoted = false;
				continue;
			}
			if (char === '"') { quoted = true; continue; }
			if (char === "{") depth += 1;
			if (char === "}") depth -= 1;
			if (depth !== 0) continue;
			try {
				return JSON.parse(scriptText.slice(start, index + 1));
			} catch {
				return null;
			}
		}
		return null;
	};
	// Only the page's own list region counts: the selected tab's content. The
	// header, sidebar, masthead and any other tab can hold unrelated lists.
	const listRegion = (data) => {
		const contents = isObject(data) ? data.contents : null;
		if (!isObject(contents)) return null;
		const layout = contents.twoColumnBrowseResultsRenderer ?? contents.singleColumnBrowseResultsRenderer;
		const tabs = isObject(layout) ? layout.tabs : undefined;
		if (!Array.isArray(tabs)) return contents;
		const renderers = tabs.map((tab) => (isObject(tab) ? tab.tabRenderer : null)).filter(isObject);
		const selected = renderers.filter((renderer) => renderer.selected === true);
		return selected.length === 1 && isObject(selected[0].content) ? selected[0].content : null;
	};
	const historyBootstrapFacts = (data) => {
		const region = listRegion(data);
		const section = isObject(region?.sectionListRenderer) ? region.sectionListRenderer : null;
		if (!section) return null;
		const pending = [section];
		const seen = new Set();
		const tokens = new Set();
		let items = 0;
		const rendererCounts = {};
		let hasContinuation = false;
		let visited = 0;
		let bounded = true;
		while (pending.length) {
			const node = pending.pop();
			if (Array.isArray(node)) {
				for (const child of node) pending.push(child);
				continue;
			}
			if (!isObject(node) || seen.has(node)) continue;
			seen.add(node);
			visited += 1;
			if (visited > 10000) { bounded = false; break; }
			for (const [key, child] of Object.entries(node)) {
				if (ITEM_KEYS.includes(key)) { items += 1; rendererCounts[key] = (rendererCounts[key] ?? 0) + 1; continue; }
				if (key === "continuationItemRenderer" && isObject(child)) {
					hasContinuation = true;
					const command = child.continuationEndpoint?.continuationCommand ?? child.continuationCommand;
					if (typeof command?.token === "string" && command.token.length > 0 && command.token.length <= 4096) tokens.add(command.token);
					else bounded = false;
				}
				if (key === "nextContinuationData") {
					hasContinuation = true;
					if (typeof child?.continuation === "string" && child.continuation.length > 0 && child.continuation.length <= 4096) tokens.add(child.continuation);
					else bounded = false;
				}
				if (key === "continuations" && Array.isArray(child)) {
					if (child.length > 0) hasContinuation = true;
					for (const continuation of child) {
						const token = continuation?.nextContinuationData?.continuation;
						if (typeof token === "string" && token.length > 0 && token.length <= 4096) tokens.add(token);
						else bounded = false;
					}
				}
				if (isObject(child) || Array.isArray(child)) pending.push(child);
			}
		}
		if (tokens.size > 8) bounded = false;
		return { items, rendererCounts, tokens: bounded ? Array.from(tokens) : [], hasContinuation, bounded };
	};
	const hasSelectedTabContent = (data) => {
		const contents = isObject(data) ? data.contents : null;
		if (!isObject(contents)) return false;
		const layout = contents.twoColumnBrowseResultsRenderer ?? contents.singleColumnBrowseResultsRenderer;
		const tabs = isObject(layout) ? layout.tabs : undefined;
		if (!Array.isArray(tabs)) return false;
		const selected = tabs.map((tab) => isObject(tab) ? tab.tabRenderer : null)
			.filter((renderer) => isObject(renderer) && renderer.selected === true);
		return selected.length === 1 && isObject(selected[0].content);
	};
	const regionFacts = (data, playlistIndex) => {
		const region = listRegion(data);
		if (region === null) return null;
		const facts = { items: 0, continuation: false, lists: 0, emptyLists: 0, emptyMessage: false, rejectedMessage: false, selectedTabContent: hasSelectedTabContent(data), loading: false, playlistIndexEmpty: false, playlistEmpty: false, historyEmpty: false };
		const visit = (value) => {
			if (Array.isArray(value)) {
				for (const child of value) visit(child);
				return;
			}
			if (!isObject(value)) return;
			for (const [key, child] of Object.entries(value)) {
				if (
					(key === "isLoading" && child === true) ||
					/(?:loadingSpinnerRenderer|spinnerRenderer|loadingIndicator)$/i.test(key)
				) facts.loading = true;
				if (ITEM_KEYS.includes(key)) {
					if (!(playlistIndex && isBuiltInLockup(child))) facts.items += 1;
					continue;
				}
				if (key === "continuationItemRenderer" || key === "nextContinuationData") facts.continuation = true;
				if (key === "continuations" && Array.isArray(child) && child.length > 0) facts.continuation = true;
				if (EMPTY_MESSAGE_KEYS.includes(key) && isObject(child)) {
					if (isRecognizedEmptyText(textFragments(child).join(" "))) facts.emptyMessage = true;
					else facts.rejectedMessage = true;
					continue;
				}
				if (LIST_KEYS.includes(key) && isObject(child)) {
					facts.lists += 1;
					const contents = child.contents ?? child.items;
					const onlyBuiltIns = playlistIndex && Array.isArray(contents) && contents.length > 0 && contents.every(isBuiltInLockup);
					if ((onlyBuiltIns || (!playlistIndex && Array.isArray(contents) && contents.length === 0)) &&
						(!Array.isArray(child.continuations) || child.continuations.length === 0)) facts.emptyLists += 1;
				}
				visit(child);
			}
		};
		visit(region);
		if (playlistIndex) facts.playlistIndexEmpty = facts.selectedTabContent && facts.lists === 1 && facts.emptyLists === 1 && facts.items === 0 && !facts.continuation && !facts.loading && !facts.rejectedMessage;
		if (!playlistIndex && facts.selectedTabContent) {
			const layout = data.contents?.twoColumnBrowseResultsRenderer ?? data.contents?.singleColumnBrowseResultsRenderer;
			const tabs = layout?.tabs;
			const selected = Array.isArray(tabs) ? tabs.map((tab) => tab?.tabRenderer).filter((tab) => tab?.selected === true) : [];
			const sections = selected.length === 1 ? selected[0].content?.sectionListRenderer?.contents : null;
			const section = Array.isArray(sections) && sections.length === 1 ? sections[0]?.itemSectionRenderer : null;
			const sectionContents = section?.contents;
			facts.playlistEmpty = Array.isArray(sectionContents) && sectionContents.length === 1 &&
				isObject(sectionContents[0]?.messageRenderer) &&
				isRecognizedEmptyText(textFragments(sectionContents[0].messageRenderer).join(" ")) &&
				!facts.items && !facts.continuation && !facts.loading && !facts.rejectedMessage;
			facts.historyEmpty = Array.isArray(sectionContents) && sectionContents.length === 1 &&
				isObject(sectionContents[0]?.messageRenderer) &&
				isRecognizedEmptyText(textFragments(sectionContents[0].messageRenderer).join(" ")) &&
				!facts.items && !facts.continuation && !facts.loading && !facts.rejectedMessage;
		}
		return facts;
	};
	const pageDataFacts = (playlistIndex) => {
		const candidates = [window.ytInitialData];
		for (const script of Array.from(document.querySelectorAll("script"))) {
			const parsed = readJsonText(script.textContent ?? "");
			if (parsed) candidates.push(parsed);
		}
		return candidates.map((data) => regionFacts(data, playlistIndex)).filter((facts) => facts !== null);
	};
	const historyDataFacts = () => {
		const candidates = [window.ytInitialData];
		for (const script of Array.from(document.querySelectorAll("script"))) {
			const parsed = readJsonText(script.textContent ?? "");
			if (parsed) candidates.push(parsed);
		}
		return candidates.map(historyBootstrapFacts).filter((facts) => facts !== null);
	};
`;

const PAGE_READINESS_FUNCTION = `({ content, empty, playlistIndex }) => {
	${PAGE_DATA_HELPERS}
	const hasEnumerableContent = playlistIndex
		? Array.from(document.querySelectorAll(content)).some(isEnumerablePlaylistLink)
		: Boolean(document.querySelector(content));
	if (hasEnumerableContent) return "content";
	const facts = pageDataFacts(Boolean(playlistIndex));
	if (playlistIndex && onPlaylistIndexPage() && !hasPageWall() && !hasDomLoading() && hasOnlyBuiltInPlaylistCards() && facts.length > 0 && facts.every((f) => f.playlistIndexEmpty)) return "empty";
	if (!playlistIndex && onPlaylistPage() && !hasPageWall() && facts.length > 0 && facts.every((f) => f.playlistEmpty)) return "empty";
	if (playlistIndex && document.querySelector("yt-lockup-view-model")) return "content";
	if (!playlistIndex && Array.from(document.querySelectorAll(empty)).some((node) =>
		isRecognizedEmptyText(node.textContent ?? ""))) return "empty";
	return false;
}`;

const LIST_END_FUNCTION = `(request) => {
	${PAGE_DATA_HELPERS}
	const kind = typeof request === "string" ? request : request.kind;
	const sessionPresent = typeof request === "string" ? true : request.sessionPresent !== false;
	const facts = pageDataFacts(kind === "playlist-index");
	const historyFacts = kind === "history" ? historyDataFacts() : [];
	let declaredTotal = null;
	if (kind === "playlist") {
		const nodes = document.querySelectorAll(".yt-content-metadata-view-model__metadata-text, .ytContentMetadataViewModelMetadataText");
		for (const node of Array.from(nodes)) {
			const match = /^([\\d,]+)\\s+videos?$/i.exec((node.textContent ?? "").trim());
			if (!match) continue;
			declaredTotal = Number(match[1].replace(/,/g, ""));
			break;
		}
	}
	let domItemCount = null;
	if (kind === "history") {
		domItemCount = Array.from(document.querySelectorAll(
			"ytd-item-section-renderer yt-lockup-view-model, ytd-item-section-renderer ytd-video-renderer",
		)).filter((node) =>
			!node.matches("ytd-video-renderer") || !node.querySelector("yt-lockup-view-model"),
		).length;
	}
	if (kind === "playlist")
		domItemCount = document.querySelectorAll("yt-lockup-view-model, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer").length;
	if (kind === "subscriptions") domItemCount = document.querySelectorAll("ytd-channel-renderer").length;
	if (kind === "playlist-index") {
		const ids = new Set();
		for (const anchor of Array.from(document.querySelectorAll('a[href*="list="]')))
			if (isEnumerablePlaylistLink(anchor)) ids.add(new URL(anchor.getAttribute("href") ?? "", BASE).searchParams.get("list"));
		domItemCount = ids.size;
	}
	const endText = Array.from(document.querySelectorAll("#contents #message, .ytd-item-section-renderer #message"))
		.map((node) => node.textContent ?? "")
		.join(" ");
	const continuationSelector = kind === "subscriptions"
		? "ytd-expanded-shelf-contents-renderer ytd-continuation-item-renderer"
		: kind === "playlist-index"
			? "ytd-rich-grid-renderer ytd-continuation-item-renderer, ytd-grid-renderer ytd-continuation-item-renderer"
			: kind === "history"
				? "ytd-item-section-renderer ytd-continuation-item-renderer"
				: "ytd-playlist-video-list-renderer ytd-continuation-item-renderer, #contents ytd-playlist-video-list-renderer ytd-continuation-item-renderer";
	return {
		// A region with no recognized entry (an error, an unrelated payload) shows
		// neither a last page nor a next page, so it is not readable evidence.
		dataReadable: kind === "history"
			? historyFacts.some((f) => f.bounded && f.items > 0)
			: facts.some((f) => f.items > 0),
		dataItemCount: kind === "history"
			? historyFacts.reduce((most, f) => Math.max(most, f.items), 0)
			: facts.reduce((most, f) => Math.max(most, f.items), 0),
		dataHasContinuation: kind === "history"
			? historyFacts.some((f) => f.hasContinuation)
			: facts.some((f) => f.continuation),
		...(kind === "history" ? {
			historyBootstrapContinuationTokens: historyFacts.flatMap((f) => f.tokens).slice(0, 8),
			historyBootstrapItemCount: historyFacts.reduce((most, f) => Math.max(most, f.items), 0),
			historyBootstrapRendererCounts: historyFacts.reduce((most, f) => f.items > most.items ? f : most, { items: 0, rendererCounts: {} }).rendererCounts,
		} : {}),
		domHasContinuation: Boolean(document.querySelector(continuationSelector)),
		declaredTotal,
		domItemCount,
		domHasEndMarker: /(?:no more (?:videos|items)|end of (?:the )?list|you(?:'|’)ve reached the end)/i.test(endText),
		pageBlocked: !sessionPresent || hasPageWall() || hasDomLoading() || !onTargetRoute(kind) ||
			facts.some((f) => f.rejectedMessage || f.loading),
		latestHistoryResponse:
			kind === "history" && typeof request !== "string"
				? request.latestHistoryResponse ?? null
				: null,
		verifiedEmpty: sessionPresent && !hasPageWall() && !hasDomLoading() && facts.length > 0 &&
			(kind === "playlist-index"
				? onPlaylistIndexPage() && hasOnlyBuiltInPlaylistCards() && facts.every((f) => f.playlistIndexEmpty)
				: kind === "playlist"
					? onPlaylistPage() && !document.querySelector("yt-lockup-view-model, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer") && facts.every((f) => f.playlistEmpty)
					: kind === "subscriptions"
						? onSubscriptionsPage() && facts.every((f) => f.selectedTabContent && f.lists > 0 && f.emptyMessage && f.emptyLists === f.lists && f.items === 0 && !f.continuation && !f.loading && !f.rejectedMessage)
						: kind === "history"
							? sessionPresent && !hasPageWall() && !hasDomLoading() && onTargetRoute(kind) && facts.every((f) => f.historyEmpty)
							: false),
	};
}`;

type PageReadinessArgs = {
	content: string;
	empty: string;
	/** Count only the playlists `readPlaylistLinks` enumerates as content. */
	playlistIndex?: boolean;
};

/** Runs in the page. Exported so tests can run it against a parsed document. */
export const readPageReadiness = new Function(
	"args",
	`return (${PAGE_READINESS_FUNCTION})(args);`,
) as (args: PageReadinessArgs) => PageReadiness;

/** Runs in the page after enumeration. Reads the source's own end evidence. */
export const readListEnd = Object.defineProperty(
	new Function("request", `return (${LIST_END_FUNCTION})(request);`),
	"name",
	{ value: "readListEnd" },
) as (request: ListKind | ListEndRequest) => ListEnd;
