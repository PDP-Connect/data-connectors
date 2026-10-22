// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Synthetic data only. CORS is fulfilled by the harness, not device evidence.
let loggedIn = true;
export const setLoggedIn = (value) => { loggedIn = value; };
const json = (body, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const html = () => ({ status: 200, contentType: "text/html", body: '<!doctype html><script src="https://open.spotifycdn.com/fixture.js"></script>' });
const operations = ["profileAttributes", "libraryV3", "fetchPlaylist", "fetchLibraryTracks", "userTopContent"];
export function savedTrack(id = "syntheticTrack") {
	return {
		addedAt: { isoString: "2026-10-01T00:00:00Z" },
		track: { uri: "spotify:track:" + id, data: {
			name: "Synthetic track", artists: { items: [] },
			albumOfTrack: { name: "Synthetic album", artists: { items: [] } },
			duration: { totalMilliseconds: 1000 }, contentRating: { label: "NONE" },
		} },
	};
}
export function resolveFixture(raw, request = {}) {
	const url = new URL(raw);
	if (url.hostname === "open.spotifycdn.com") return {
		status: 200, contentType: "application/javascript",
		body: "/* " + operations.map((name, i) => 'new a.b("' + name + '","query","' + String(i + 1).repeat(64) + '")').join(";") + " */",
	};
	if (url.pathname === "/api/server-time") return json({ serverTime: 1_700_000_000 });
	if (url.pathname === "/api/token") return json({ accessToken: "synthetic-token", clientId: "synthetic-client", isAnonymous: !loggedIn });
	if (url.hostname === "clienttoken.spotify.com") return json({ granted_token: { token: "synthetic-client-token" } });
	if (url.pathname.includes("/user-profile-view/")) return json({ uri: "spotify:user:syntheticOwner", image_url: null, followers_count: 0, following_count: 0 });
	if (url.pathname.includes("/recently-played/")) return json({ playContexts: [{ uri: "spotify:playlist:syntheticPlaylist", lastPlayedTime: 1790812800000, lastPlayedTrackUri: "spotify:track:syntheticTrack" }] });
	if (url.hostname === "api-partner.spotify.com") {
		const { operationName, variables = {} } = JSON.parse(request.postData ?? "{}");
		if (operationName === "profileAttributes") return json({ data: { me: { profile: { username: "syntheticOwner", name: "Synthetic owner", uri: "spotify:user:syntheticOwner", imageUrl: null } } } });
		if (operationName === "libraryV3") return json({ data: { me: { libraryV3: { offset: variables.offset, totalCount: 1, items: [{ item: { data: { __typename: "Playlist", uri: "spotify:playlist:syntheticPlaylist" } } }] } } } });
		if (operationName === "fetchPlaylist") return json({ data: { playlistV2: {
			uri: "spotify:playlist:syntheticPlaylist", name: "Synthetic playlist",
			revisionId: "synthetic-revision", ownerV2: { data: { uri: "spotify:user:syntheticOwner", name: "Synthetic owner" } },
			description: null, followers: 0, images: { items: [] },
			content: { offset: variables.offset, totalCount: 1, items: [{
				addedAt: { isoString: "2026-10-01T00:00:00Z" }, addedBy: { data: { name: "Synthetic owner" } },
				itemV2: { data: { __typename: "Track", uri: "spotify:track:syntheticTrack", name: "Synthetic track",
					artists: { items: [] }, albumOfTrack: { name: "Synthetic album" }, trackDuration: { totalMilliseconds: 1000 } } },
			}] },
		} } });
		if (operationName === "fetchLibraryTracks") return json({ data: { me: { library: { tracks: { offset: variables.offset, totalCount: 1, items: [savedTrack()] } } } } });
		if (operationName === "userTopContent") return json({ data: { me: { profile: { topArtists: { totalCount: 1, items: [{ uri: "spotify:artist:syntheticArtist", name: "Synthetic artist" }] }, topTracks: { totalCount: 1, items: [{ uri: "spotify:track:syntheticTrack", name: "Synthetic track", artists: { items: [] }, albumOfTrack: { name: "Synthetic album" } }] } } } } });
		return json({ errors: [{ message: "unexpected synthetic operation" }] }, 400);
	}
	return html();
}
export const spotifyFixtures = {
	hosts: /^https:\/\/(?:open\.spotify\.com|accounts\.spotify\.com|open\.spotifycdn\.com|clienttoken\.spotify\.com|api-partner\.spotify\.com|spclient\.wg\.spotify\.com)\//,
	resolve: resolveFixture, setLoggedIn,
	loginUrl: "https://accounts.spotify.com/en/login?continue=https%3A%2F%2Fopen.spotify.com%2F",
	homeUrl: "https://open.spotify.com/",
};
export const streams = ["playlists", "playlist_items", "saved_tracks", "profile", "recently_played_contexts", "top_artists", "top_tracks"];
export const pageshimCase = {
	fixtures: spotifyFixtures,
	scopes: streams.map((stream) => "spotify." + stream),
	exportSummary: { count: 9, label: "records", details: { playlists: 1, playlist_items: 1, saved_tracks: 1, profile: 1, recently_played_contexts: 1, top_artists: 2, top_tracks: 2 } },
	emptyExportSummary: { count: 0, label: "records", details: Object.fromEntries(streams.map((stream) => [stream, 0])) },
	partialErrors: [
		{ errorClass: "partial", reason: "Spotify's recently played list reports no total, so the connector cannot show it read the whole list; no checkpoint was saved.", disposition: "degraded", scope: "spotify.recently_played_contexts", phase: "collect" },
	],
};
