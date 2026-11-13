// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Record shapes the Mountain Project connector emits. Kept out of index.ts so
// the pure builders in parsers.ts can be tested without the browser runtime.

/** Route fields both CSV exports carry, as Mountain Project states them. */
export interface RouteFields {
	/** Mountain Project's average star rating for the route. */
	avg_stars: number | null;
	/** Length in feet, as the export states it. */
	length_ft: number | null;
	/** The location path, outermost area first. */
	location: string[];
	/** Route grade as displayed (YDS, V, WI, ...); several systems can appear. */
	rating: string | null;
	/** Mountain Project's numeric sort code for the grade. */
	rating_code: number | null;
	route_id: string;
	route_name: string;
	/** Route types, e.g. ["Trad", "Alpine"]. */
	route_type: string[];
	route_url: string;
	/** The owner's own suggested grade, when they gave one. */
	your_rating: string | null;
	/** The owner's own star rating of the route, when they gave one. */
	your_stars: number | null;
}

export interface TickRecord extends RouteFields {
	/** `<route_id>:<date>:<n>`; n counts same-route same-day ticks in export order. */
	id: string;
	/** Day of the tick, YYYY-MM-DD. */
	date: string;
	lead_style: string | null;
	notes: string | null;
	/** Pitches recorded on the tick. */
	pitches: number | null;
	style: string | null;
}

export interface SavedRouteRecord extends RouteFields {
	/** The route id; a route is on the to-do list at most once. */
	id: string;
	/** The route's pitch count. */
	pitches: number | null;
}

export interface ProfileRecord {
	avatar_url: string | null;
	display_name: string;
	id: string;
	location: string | null;
	member_since: string | null;
	profile_url: string;
	tick_count: number | null;
	todo_count: number | null;
}
