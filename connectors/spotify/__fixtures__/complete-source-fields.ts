// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Synthetic Spotify responses in these tests describe one behavior at a time.
// Spotify normally provides every mapped field, and the connector withholds a
// row whose field is ABSENT. This fills the keys a fixture did not mention so
// that unrelated fixtures stay complete; keys a fixture sets (including to
// null, [] or a malformed value) are never touched.

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fill(target: unknown, defaults: Obj): void {
	if (!isObj(target)) return;
	for (const [key, value] of Object.entries(defaults)) {
		if (!Object.hasOwn(target, key)) target[key] = value;
	}
}

function tail(uri: unknown): string {
	return typeof uri === "string" ? (uri.split(":").at(-1) ?? "") : "";
}

export function completeSourceFields(
	operationName: string,
	response: unknown,
): unknown {
	if (!isObj(response)) return response;
	const data = isObj(response.data) ? response.data : null;
	if (operationName === "fetchPlaylist") {
		const playlist = data?.playlistV2;
		if (!isObj(playlist)) return response;
		fill(playlist, {
			name: "Playlist",
			public: false,
			collaborative: false,
			description: null,
			followers: 0,
			images: { items: [] },
			ownerV2: { data: { uri: "spotify:user:owner", name: "Owner" } },
		});
		if (!Object.hasOwn(playlist, "snapshotId")) {
			fill(playlist, { revisionId: "revision" });
		}
		const items = isObj(playlist.content) ? playlist.content.items : null;
		if (!Array.isArray(items)) return response;
		for (const item of items) {
			if (!isObj(item)) continue;
			fill(item, {
				addedAt: { isoString: "2024-01-01T00:00:00Z" },
				addedBy: { data: { name: "Adder" } },
			});
			const track = isObj(item.itemV2) ? item.itemV2.data : null;
			if (!isObj(track) || track.__typename !== "Track") continue;
			fill(track, {
				id: tail(track.uri),
				albumOfTrack: { name: "Album" },
				trackDuration: { totalMilliseconds: 1000 },
			});
		}
	}
	if (operationName === "fetchLibraryTracks") {
		const me = isObj(data?.me) ? data.me : null;
		const library = isObj(me?.library) ? me.library : null;
		const tracks = isObj(library?.tracks) ? library.tracks : null;
		if (!Array.isArray(tracks?.items)) return response;
		for (const item of tracks.items) {
			if (!isObj(item)) continue;
			const container = isObj(item.track) ? item.track : null;
			const track = isObj(container?.data) ? container.data : null;
			if (!track) continue;
			fill(track, {
				id: tail(container?.uri ?? container?._uri),
				duration: { totalMilliseconds: 1000 },
				contentRating: { label: "NONE" },
				popularity: 0,
				externalIds: { isrc: null },
				artists: { items: [] },
			});
			if (!Object.hasOwn(track, "albumOfTrack")) {
				track.albumOfTrack = { name: "Album", artists: { items: [] } };
			} else if (isObj(track.albumOfTrack)) {
				fill(track.albumOfTrack, { name: "Album", artists: { items: [] } });
			}
		}
	}
	return response;
}
