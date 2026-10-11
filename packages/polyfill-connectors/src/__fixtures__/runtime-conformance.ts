// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Fault injection at the real stdio runtime boundary; no provider or browser.
import { createConnectorFailure, runConnector } from "../connector-runtime.ts";
import { observe } from "../observation.ts";

runConnector({
	name:
		process.env.PDPP_TEST_MODE === "tombstone"
			? "gmail"
			: "runtime_conformance",
	isTombstone: () => process.env.PDPP_TEST_MODE === "tombstone",
	protocolCapabilities: ["OBSERVATION"],
	async collect(ctx) {
		if (process.env.PDPP_TEST_MODE === "raw_resume") {
			const response = new Promise<void>((resolve) => {
				process.stdin.once("data", () => resolve());
			});
			await ctx.emit({
				type: "INTERACTION",
				kind: "otp",
				message: "Enter the code",
				request_id: "pending_1",
			});
			await response;
			await ctx.emitRecord("items", { id: "item-1" });
			return;
		}
		if (process.env.PDPP_TEST_MODE === "second_start_chunk") {
			return;
		}
		if (process.env.PDPP_TEST_MODE === "second_start_after_done") {
			return;
		}
		if (
			process.env.PDPP_TEST_MODE === "write_then_success" ||
			process.env.PDPP_TEST_MODE === "write_then_stream_failure"
		) {
			if (process.env.PDPP_TEST_MODE === "write_then_stream_failure") {
				await ctx.reportStreamFailure?.("items", "Source unavailable");
			}
			ctx
				.emitRecord("items", { id: "item-1", payload: "x".repeat(262_144) })
				.catch(() => undefined);
			return;
		}
		if (process.env.PDPP_TEST_MODE === "write_then_failure") {
			ctx
				.emitRecord("items", { id: "item-1", payload: "x".repeat(262_144) })
				.catch(() => undefined);
			throw createConnectorFailure(
				"test_fatal",
				"Failure after a queued record",
			);
		}
		if (process.env.PDPP_TEST_MODE === "tombstone") {
			await ctx.emitRecord("labels", { name: "INBOX", deleted: true });
			return;
		}
		if (process.env.PDPP_TEST_MODE === "second_start") {
			await ctx.progress("Collecting items");
			await new Promise<void>((resolve) => {
				process.stdin.once("end", resolve);
			});
			return;
		}
		const pending = ctx.sendInteraction({
			kind: "otp",
			message: "Enter the code",
			request_id: "pending_1",
		});
		// A parallel branch may fail without ever awaiting the interaction.
		pending.catch(() => undefined);
		if (process.env.PDPP_TEST_MODE === "failure") {
			throw createConnectorFailure(
				"test_fatal",
				"Connector's original failure",
			);
		}
		if (process.env.PDPP_TEST_MODE === "ignore_closed_interaction") {
			await pending.catch(() => undefined);
			await ctx.emitRecord("items", { id: "item-1" });
			return;
		}
		if (process.env.PDPP_TEST_MODE === "second_start_pending") {
			await pending;
			return;
		}
		if (process.env.PDPP_TEST_MODE === "resume") {
			await pending;
			await ctx.emitRecord("items", { id: "item-1" });
			return;
		}
		if (process.env.PDPP_TEST_MODE === "emit_record") {
			await ctx.emitRecord("items", { id: "item-1" });
		} else if (process.env.PDPP_TEST_MODE === "interaction") {
			await ctx.sendInteraction({ kind: "otp", message: "Another code" });
		} else if (process.env.PDPP_TEST_MODE === "detail_page") {
			await ctx.requestDetailGapPage();
		} else if (process.env.PDPP_TEST_MODE === "observation") {
			observe({
				fact: "wait_expired",
				step: "sign_in",
				attrs: { awaited: "otp", budget_ms: 1000 },
			});
		} else {
			await ctx.emit(JSON.parse(process.env.PDPP_TEST_MESSAGE ?? "{}"));
		}
	},
});
