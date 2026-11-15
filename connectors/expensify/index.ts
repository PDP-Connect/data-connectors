// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { isMainModule } from "@pdpp/connector-protocol";
import { readOptions } from "../../packages/polyfill-connectors/src/connector-options.ts";
import {
	type CollectContext,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { createExpensifyClient } from "./client.ts";
import { collectExpensify, type ExpensifyCollectDeps } from "./collect.ts";

type ClientFactory = (
	options: Parameters<typeof createExpensifyClient>[0],
) => ExpensifyCollectDeps["client"];
type Context = Pick<
	CollectContext,
	"credentials" | "requested" | "emit" | "emitRecord" | "progress"
>;

export async function collect(
	ctx: Context,
	clientFactory: ClientFactory = createExpensifyClient,
	now: () => Date = () => new Date(),
): Promise<void> {
	const partnerUserID = ctx.credentials.EXPENSIFY_PARTNER_USER_ID;
	const partnerUserSecret = ctx.credentials.EXPENSIFY_PARTNER_USER_SECRET;
	if (!partnerUserID?.trim() || !partnerUserSecret?.trim()) {
		throw new Error("expensify_credentials_missing");
	}
	const rawHistory = process.env.EXPENSIFY_HISTORY_YEARS;
	if (rawHistory !== undefined && !/^[1-9][0-9]*$/.test(rawHistory)) {
		throw new Error("Expensify years must be a positive safe integer");
	}
	const options = readOptions(null, {
		envPrefix: "EXPENSIFY_",
		fields: { HISTORY_YEARS: { parse: "int", default: 3 } },
	});
	const client = clientFactory({
		partnerUserID,
		partnerUserSecret,
		fetch: (url, init) => globalThis.fetch(url, init),
		now: () => now().getTime(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	});
	await collectExpensify({
		client,
		now,
		years: options.HISTORY_YEARS as number,
		requested: ctx.requested,
		emit: ctx.emit,
		emitRecord: ctx.emitRecord,
		progress: ctx.progress,
	});
}

export const connectorConfig = {
	name: "expensify",
	auth: {
		kind: "env" as const,
		required: [
			["EXPENSIFY_PARTNER_USER_ID"],
			["EXPENSIFY_PARTNER_USER_SECRET"],
		],
	},
	collect,
};

if (isMainModule(import.meta.url)) {
	runConnector(connectorConfig);
}
