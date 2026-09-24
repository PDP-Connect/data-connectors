// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Real runConnector envelopes with the production YouTube session hook and a routed page stand-in.
import { runConnector } from "../../../packages/polyfill-connectors/src/connector-runtime.ts";
import { ensureYoutubeSession, youtubeConnectorConfig } from "../index.ts";

runConnector({
	name: "youtube-session-protocol-fixture",
	async collect(ctx) {
		let signedIn = false;
		const sibling = {
			url: "about:blank",
			async goto(url: string) {
				this.url = url;
			},
			async waitForFunction() {
				return {
					jsonValue: async () => "content",
					dispose: async () => undefined,
				};
			},
			async evaluate() {
				return this.url === "https://www.youtube.com/" && signedIn;
			},
			async close() {
				/* probe cleanup */
			},
		};
		const owner = {
			url: "about:blank",
			async goto(url: string) {
				this.url = url;
			},
			async waitForFunction() {
				return {
					jsonValue: async () => "content",
					dispose: async () => undefined,
				};
			},
			async evaluate() {
				return this.url === "https://www.youtube.com/" && signedIn;
			},
			context() {
				return { newPage: async () => sibling };
			},
		};
		const timeout = process.env.YOUTUBE_FIXTURE_TIMEOUT === "1";
		const args = {
			...ctx,
			page: owner,
			assist: async (request: Parameters<typeof ctx.assist>[0]) => {
				const id = await ctx.assist(request);
				if (!timeout) signedIn = true;
				return id;
			},
		};
		if (timeout) await ensureYoutubeSession(args as never, 0);
		else await youtubeConnectorConfig.ensureSession(args as never);
	},
});
