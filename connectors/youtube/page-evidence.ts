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

export interface ListEnd {
	/** The target page's own `ytInitialData` list region held recognized entries. */
	readonly dataReadable: boolean;
	/** Items in that region at page load. */
	readonly dataItemCount: number;
	/** That region had a next-page continuation at page load. */
	readonly dataHasContinuation: boolean;
	/** The rendered page still shows a next-page continuation. */
	readonly domHasContinuation: boolean;
	/** The "N videos" total the page header declares (playlist pages only). */
	readonly declaredTotal: number | null;
	/** Rendered items before the connector's own row limit (kinds with one). */
	readonly domItemCount: number | null;
}

/**
 * True only when the source shows the end of the list. Either the header total
 * equals what was read, or the page's own data had no next page and every item
 * in it was read. A header total that differs from the read count is not an end.
 * A missing next-page control, a timeout, an unreadable page, or row growth is
 * not evidence: the final source response is never observed.
 */
export function enumerationEnded(
	end: ListEnd | null | undefined,
	renderedCount: number,
): boolean {
	if (!end) return false;
	if (end.domItemCount !== null && end.domItemCount > renderedCount)
		return false;
	if (end.declaredTotal !== null) return end.declaredTotal === renderedCount;
	if (!end.dataReadable || end.dataHasContinuation || end.domHasContinuation)
		return false;
	return renderedCount >= end.dataItemCount;
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
	const isEnumerablePlaylistLink = (anchor) => {
		try {
			const url = new URL(anchor.getAttribute("href") ?? "", BASE);
			const listId = url.searchParams.get("list");
			return url.origin === BASE && Boolean(listId) && listId !== "LL" && listId !== "WL";
		} catch {
			return false;
		}
	};
	const EMPTY_MESSAGE_KEYS = ["messageRenderer", "backgroundPromoRenderer", "ytdMessageRenderer", "ytdBackgroundPromoRenderer"];
	const LIST_KEYS = ["richGridRenderer", "gridRenderer", "playlistVideoListRenderer"];
	const ITEM_KEYS = [
		"videoRenderer", "gridVideoRenderer", "playlistVideoRenderer", "playlistPanelVideoRenderer",
		"compactVideoRenderer", "videoWithContextRenderer", "richItemRenderer", "lockupViewModel",
		"shortsLockupViewModel", "reelItemRenderer", "channelRenderer", "gridChannelRenderer",
		"gridPlaylistRenderer", "playlistRenderer", "compactPlaylistRenderer",
	];
	const BUILT_IN_PLAYLIST = /"(?:contentId|playlistId)":"(?:LL|WL)"|playlist\?list=(?:LL|WL)(?![\w-])/;
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
		const chosen = selected.length === 1 ? selected : renderers.length === 1 ? renderers : [];
		return chosen.length === 1 && isObject(chosen[0].content) ? chosen[0].content : null;
	};
	const regionFacts = (data, playlistIndex) => {
		const region = listRegion(data);
		if (region === null) return null;
		const facts = { items: 0, continuation: false, lists: 0, emptyLists: 0, emptyMessage: false };
		const visit = (value) => {
			if (Array.isArray(value)) {
				for (const child of value) visit(child);
				return;
			}
			if (!isObject(value)) return;
			for (const [key, child] of Object.entries(value)) {
				if (ITEM_KEYS.includes(key)) {
					if (!(playlistIndex && BUILT_IN_PLAYLIST.test(JSON.stringify(child)))) facts.items += 1;
					continue;
				}
				if (key === "continuationItemRenderer" || key === "nextContinuationData") facts.continuation = true;
				if (key === "continuations" && Array.isArray(child) && child.length > 0) facts.continuation = true;
				if (EMPTY_MESSAGE_KEYS.includes(key) && isObject(child)) {
					if (isRecognizedEmptyText(textFragments(child).join(" "))) facts.emptyMessage = true;
					continue;
				}
				if (LIST_KEYS.includes(key) && isObject(child)) {
					facts.lists += 1;
					const contents = child.contents ?? child.items;
					if (Array.isArray(contents) && contents.length === 0 && !child.continuations) facts.emptyLists += 1;
				}
				visit(child);
			}
		};
		visit(region);
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
`;

const PAGE_READINESS_FUNCTION = `({ content, empty, playlistIndex }) => {
	${PAGE_DATA_HELPERS}
	const hasContent = playlistIndex
		? Array.from(document.querySelectorAll(content)).some(isEnumerablePlaylistLink)
		: Boolean(document.querySelector(content));
	if (hasContent) return "content";
	if (Array.from(document.querySelectorAll(empty)).some((node) =>
		isRecognizedEmptyText(node.textContent ?? ""))) return "empty";
	const facts = pageDataFacts(Boolean(playlistIndex));
	// Every readable copy of the page data must show no item, no next page and no
	// non-empty list. Another list's empty payload cannot prove this one empty.
	const holdsNothing = (f) => f.items === 0 && !f.continuation && f.emptyLists === f.lists;
	return facts.some((f) => f.emptyMessage || f.emptyLists > 0) && facts.every(holdsNothing)
		? "empty"
		: false;
}`;

const LIST_END_FUNCTION = `(kind) => {
	${PAGE_DATA_HELPERS}
	const facts = pageDataFacts(kind === "playlist-index");
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
	if (kind === "subscriptions") domItemCount = document.querySelectorAll("ytd-channel-renderer").length;
	if (kind === "playlist-index") {
		const ids = new Set();
		for (const anchor of Array.from(document.querySelectorAll('a[href*="playlist?list="]')))
			if (isEnumerablePlaylistLink(anchor)) ids.add(new URL(anchor.getAttribute("href") ?? "", BASE).searchParams.get("list"));
		domItemCount = ids.size;
	}
	return {
		// A region with no recognized entry (an error, an unrelated payload) shows
		// neither a last page nor a next page, so it is not readable evidence.
		dataReadable: facts.some((f) => f.items > 0),
		dataItemCount: facts.reduce((most, f) => Math.max(most, f.items), 0),
		dataHasContinuation: facts.some((f) => f.continuation),
		domHasContinuation: Boolean(document.querySelector("ytd-continuation-item-renderer")),
		declaredTotal,
		domItemCount,
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
	new Function("kind", `return (${LIST_END_FUNCTION})(kind);`),
	"name",
	{ value: "readListEnd" },
) as (kind: ListKind) => ListEnd;
