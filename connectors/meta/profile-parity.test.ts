// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page, Response } from "playwright";
import {
	fetchProfilePageUser,
	isProfilePageGraphQLResponse,
	waitForLegacyProfileCapture,
} from "./index.ts";

function profileResponse(operation: string, body: unknown): Response {
	return {
		json: async () => body,
		request: () => ({
			headers: () => ({}),
			method: () => "POST",
			postData: () => `fb_api_req_friendly_name=${operation}`,
		}),
		status: () => 200,
		url: () => "https://www.instagram.com/graphql/query/",
	} as Response;
}

test("profile response matching accepts only the three legacy profile operations", () => {
	for (const operation of [
		"PolarisProfilePageContentQuery",
		"ProfilePageQuery",
		"UserByUsernameQuery",
	]) {
		assert.equal(
			isProfilePageGraphQLResponse(profileResponse(operation, {})),
			true,
		);
	}
	assert.equal(
		isProfilePageGraphQLResponse(profileResponse("SomeUnrelatedQuery", {})),
		false,
	);
});

test("profile response matching accepts the live /api/graphql path and rejects unrelated paths", () => {
	const response = (url: string): Response =>
		({
			...profileResponse("PolarisProfilePageContentQuery", {}),
			url: () => url,
		}) as Response;
	for (const url of [
		"https://www.instagram.com/api/graphql",
		"https://www.instagram.com/api/graphql?x=1",
		"https://www.instagram.com/graphql/query",
	]) {
		assert.equal(isProfilePageGraphQLResponse(response(url)), true, url);
	}
	for (const url of [
		"https://www.instagram.com/api/v1/web/get_profile_pic_props/",
		"https://www.instagram.com/api/graphqlx",
	]) {
		assert.equal(isProfilePageGraphQLResponse(response(url)), false, url);
	}
});

test("profile capture polls after navigation and extracts the captured user", async () => {
	const user = {
		id: "fixture-id",
		follower_count: 10,
		following_count: 20,
		is_verified: false,
		media_count: 30,
		username: "fixture-user",
	};
	const response = profileResponse("ProfilePageQuery", {
		data: { user },
	});
	const earlierResponse = profileResponse("UserByUsernameQuery", {
		data: {
			user: {
				follower_count: 1,
				following_count: 2,
				is_verified: true,
				media_count: 3,
				username: "older-user",
			},
		},
	});
	const sleeps: number[] = [];
	const listeners = new Set<(response: Response) => void>();
	const page = Object.assign({} as Page, {
		goto: async () => {
			for (const listener of listeners) listener(earlierResponse);
			for (const listener of listeners) listener(response);
			return null;
		},
		off: (_event: string, listener: (response: Response) => void) => {
			listeners.delete(listener);
			return page;
		},
		on: (_event: string, listener: (response: Response) => void) => {
			listeners.add(listener);
			return page;
		},
	});

	assert.deepEqual(
		await fetchProfilePageUser(page, "fixture-user", null, {
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		}),
		user,
	);
	assert.deepEqual(sleeps, [3_000]);
});

test("profile navigation retries transient failures within the three-attempt bound", async () => {
	const user = {
		follower_count: 1,
		following_count: 2,
		id: "fixture-id",
		is_verified: true,
		media_count: 3,
		username: "fixture-user",
	};
	const response = profileResponse("UserByUsernameQuery", {
		data: { user },
	});
	let attempts = 0;
	const listeners = new Set<(response: Response) => void>();
	const page = Object.assign({} as Page, {
		goto: async () => {
			attempts += 1;
			if (attempts < 3) throw new Error("temporary navigation failure");
			for (const listener of listeners) listener(response);
			return null;
		},
		off: (_event: string, listener: (response: Response) => void) => {
			listeners.delete(listener);
			return page;
		},
		on: (_event: string, listener: (response: Response) => void) => {
			listeners.add(listener);
			return page;
		},
	});

	assert.deepEqual(
		await fetchProfilePageUser(page, "fixture-user", null, {
			sleep: async () => undefined,
		}),
		user,
	);
	assert.equal(attempts, 3);
});

test("profile capture returns no user when the bounded wait has no matching response", async () => {
	const sleeps: number[] = [];
	const result = await waitForLegacyProfileCapture(
		[],
		{
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		},
	);
	assert.equal(result, null);
	assert.equal(sleeps.length, 31);
	assert.equal(sleeps[0], 3_000);
	assert.ok(sleeps.slice(1).every((ms) => ms === 1_000));
});
