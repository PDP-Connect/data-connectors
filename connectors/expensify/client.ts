// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createConnectorFailure } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { EXPORT_TEMPLATE } from "./template.ts";

/** Rolling-window request pacing shared by file, download and retry calls. */
export function createRequestPacer({
	now,
	sleep,
}: {
	now: () => number;
	sleep: (milliseconds: number) => Promise<void>;
}) {
	const sent: number[] = [];
	let tail: Promise<void> = Promise.resolve();
	return {
		run<T>(operation: () => Promise<T>): Promise<T> {
			const result = tail.then(async () => {
				while (true) {
					const at = now();
					if (!Number.isFinite(at)) throw new Error("Invalid pacing clock");
					while (sent.length && sent[0]! <= at - 60_000) sent.shift();
					const recent = sent.filter((time) => time > at - 10_000);
					const shortWait =
						recent.length >= 5 ? recent[recent.length - 5]! + 10_000 - at : 0;
					const longWait =
						sent.length >= 20 ? sent[sent.length - 20]! + 60_000 - at : 0;
					const wait = Math.max(shortWait, longWait);
					if (wait > 0) {
						await sleep(wait);
						continue;
					}
					sent.push(at);
					return operation();
				}
			});
			// A failed request still consumes quota, but must not poison the queue.
			tail = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		},
	};
}

/** Retry-After accepts delay seconds or an HTTP date; invalid/missing uses 10s. */
export function retryAfterDelay(value: string | null, now: number): number {
	if (!value || !value.trim()) return 10_000;
	const text = value.trim();
	if (/^\d+(?:\.\d+)?$/.test(text)) {
		const delay = Number(text) * 1000;
		return Number.isFinite(delay) ? delay : 10_000;
	}
	const at = Date.parse(text);
	return Number.isFinite(at) ? Math.max(0, at - now) : 10_000;
}

const ENDPOINT =
	"https://integrations.expensify.com/Integration-Server/ExpensifyIntegrations";
const DAY = 86_400_000;

export interface ExpensifyClientOptions {
	partnerUserID: string;
	partnerUserSecret: string;
	fetch: (
		url: string,
		init: RequestInit,
	) => Promise<Pick<Response, "status" | "headers" | "text">>;
	now: () => number;
	sleep: (milliseconds: number) => Promise<void>;
}

/** Dates and range endpoints are inclusive UTC calendar days. No real transport is selected here. */
export function createExpensifyClient(options: ExpensifyClientOptions) {
	const { partnerUserID, partnerUserSecret, fetch, now, sleep } = options;
	const pacer = createRequestPacer({ now, sleep });
	const credentials = { partnerUserID, partnerUserSecret };
	function failure(
		status: number | undefined,
		reason: string,
		responseCode?: number,
		kind: "status" | "transient" | "invalid" = "status",
	) {
		const rejected =
			status === 401 ||
			status === 407 ||
			responseCode === 401 ||
			responseCode === 407;
		const message = `Expensify HTTP ${status ?? "unavailable"}${responseCode === undefined ? "" : ` responseCode ${responseCode}`}: ${reason}`;
		// Never propagate response bodies, transport errors, filenames or supplied dates.
		const retryable =
			kind === "transient" ||
			(kind === "status" &&
				!rejected &&
				(status === undefined ||
					status === 429 ||
					(status ?? 0) >= 500 ||
					(responseCode ?? 0) >= 500));
		return createConnectorFailure(
			kind === "invalid"
				? "expensify_invalid_window"
				: kind === "status" && rejected
					? "expensify_credentials_rejected"
					: "expensify_request_failed",
			partnerUserSecret
				? message.split(partnerUserSecret).join("[redacted]")
				: message,
			{
				retryable,
				recoveryHint: {
					action: retryable ? "retry_by_runtime" : "manual_action_required",
				},
			},
		);
	}
	function date(value: string): number {
		const timestamp = Date.parse(value + "T00:00:00.000Z");
		if (
			!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
			!Number.isFinite(timestamp) ||
			new Date(timestamp).toISOString().slice(0, 10) !== value
		) {
			throw failure(undefined, "invalid calendar date", undefined, "invalid");
		}
		return timestamp;
	}
	async function request(
		job: Record<string, unknown>,
		template?: string,
	): Promise<string> {
		const body = new URLSearchParams({
			requestJobDescription: JSON.stringify({ ...job, credentials }),
		});
		if (template !== undefined) body.set("template", template);
		for (let attempt = 0; ; attempt++) {
			let response: Pick<Response, "status" | "headers" | "text">;
			try {
				response = await pacer.run(() =>
					fetch(ENDPOINT, {
						method: "POST",
						headers: { "Content-Type": "application/x-www-form-urlencoded" },
						body: body.toString(),
						redirect: "error",
					}),
				);
			} catch {
				throw failure(undefined, "transport or pacing failed");
			}
			const status = response.status;
			if (status === 401 || status === 407)
				throw failure(status, "credentials rejected");
			let text: string;
			try {
				text = await response.text();
			} catch {
				throw failure(status, "response read failed", undefined, "transient");
			}
			let responseCode: number | undefined;
			try {
				const parsed: unknown = JSON.parse(text);
				if (
					parsed !== null &&
					typeof parsed === "object" &&
					!Array.isArray(parsed) &&
					"responseCode" in parsed &&
					typeof parsed.responseCode === "number"
				) {
					responseCode = parsed.responseCode;
				}
			} catch {
				/* A successful export or file name is plain text. */
			}
			if (responseCode === 401 || responseCode === 407)
				throw failure(status, "credentials rejected", responseCode);
			if (status === 429) {
				if (attempt >= 3)
					throw failure(status, "retry limit reached", responseCode);
				try {
					await sleep(
						retryAfterDelay(response.headers.get("Retry-After"), now()),
					);
				} catch {
					throw failure(status, "retry wait failed", responseCode);
				}
				continue;
			}
			if (responseCode !== undefined && responseCode !== 200)
				throw failure(status, "API failure", responseCode);
			if (status < 200 || status >= 300)
				throw failure(status, "HTTP failure", responseCode);
			return text;
		}
	}
	async function exportReports({
		startDate,
		endDate,
	}: {
		startDate: string;
		endDate: string;
	}): Promise<string> {
		if (date(startDate) > date(endDate))
			throw failure(undefined, "reversed date range", undefined, "invalid");
		const fileName = (
			await request(
				{
					type: "file",
					onReceive: { immediateResponse: ["returnRandomFileName"] },
					inputSettings: {
						type: "combinedReportData",
						filters: { startDate, endDate },
					},
					outputSettings: { fileExtension: "txt" },
				},
				EXPORT_TEMPLATE,
			)
		).trim();
		if (!fileName) throw failure(200, "empty file name");
		return request({
			type: "download",
			fileName,
			fileSystem: "integrationServer",
		});
	}
	async function exportRange({
		from,
		to,
	}: {
		from: string;
		to: string;
	}): Promise<string> {
		let start = date(from);
		const end = date(to);
		if (start > end)
			throw failure(undefined, "reversed date range", undefined, "invalid");
		const chunks: string[] = [];
		while (start <= end) {
			const stop = Math.min(end, start + 364 * DAY);
			chunks.push(
				await exportReports({
					startDate: new Date(start).toISOString().slice(0, 10),
					endDate: new Date(stop).toISOString().slice(0, 10),
				}),
			);
			start = stop + DAY;
		}
		return chunks.join("\n");
	}
	async function listPolicies(): Promise<
		Array<{
			id: string;
			name: string;
			type: string | null;
			role: string | null;
			outputCurrency: string | null;
		}>
	> {
		const text = await request({
			type: "get",
			inputSettings: { type: "policyList" },
		});
		const malformed = () => failure(200, "invalid policy list");
		let answer: unknown;
		try {
			answer = JSON.parse(text);
		} catch {
			throw malformed();
		}
		if (
			answer === null ||
			typeof answer !== "object" ||
			Array.isArray(answer) ||
			!("responseCode" in answer) ||
			answer.responseCode !== 200 ||
			!("policyList" in answer) ||
			!Array.isArray(answer.policyList)
		)
			throw malformed();
		return answer.policyList.map((entry: unknown) => {
			if (entry === null || typeof entry !== "object" || Array.isArray(entry))
				throw malformed();
			const row = entry as Record<string, unknown>;
			const nullableString = (value: unknown): value is string | null =>
				value === null || typeof value === "string";
			if (
				typeof row.id !== "string" ||
				row.id.length === 0 ||
				typeof row.name !== "string" ||
				row.name.length === 0 ||
				!nullableString(row.type) ||
				!nullableString(row.role) ||
				!nullableString(row.outputCurrency)
			)
				throw malformed();
			return {
				id: row.id,
				name: row.name,
				type: row.type,
				role: row.role,
				outputCurrency: row.outputCurrency,
			};
		});
	}
	return { exportReports, exportRange, listPolicies };
}
