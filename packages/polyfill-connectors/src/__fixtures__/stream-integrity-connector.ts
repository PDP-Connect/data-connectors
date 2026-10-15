// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Test-only entry: runs the real runtime and replays the steps the test
// supplies, so a test can prove what the stream integrity rule does to the
// wire. A record with `bad: true` fails the shape check.
import type { EmittedMessage } from "@pdpp/connector-protocol";
import { runConnector } from "../connector-runtime.ts";
import type { FieldOmission } from "../field-reader.ts";

type Step =
	| {
			data: Record<string, unknown>;
			omissions?: FieldOmission[];
			op: "record";
			stream: string;
	  }
	| { msg: EmittedMessage; op: "emit" }
	| { op: "fail"; stream: string };

const steps = JSON.parse(process.env.PDPP_TEST_STEPS ?? "[]") as Step[];

runConnector({
	name: "stream_integrity_fixture",
	// No shipped manifest, so the fixture names its consent time field here.
	timeRangeField: "updated_at",
	...(process.env.PDPP_TEST_CHECKPOINT_PARENTS
		? {
				checkpointParents: JSON.parse(
					process.env.PDPP_TEST_CHECKPOINT_PARENTS,
				) as Record<string, string[]>,
			}
		: {}),
	validateRecord: (_stream, data) =>
		data.bad === true
			? {
					ok: false,
					issues: [{ path: "bad", message: "planted malformed row" }],
				}
			: { ok: true, data },
	async collect(ctx) {
		for (const step of steps) {
			if (step.op === "record")
				await ctx.emitRecord(
					step.stream,
					step.data,
					step.omissions ? { omissions: step.omissions } : {},
				);
			else if (step.op === "fail")
				await ctx.reportStreamFailure?.(step.stream, "planted failure", {
					retryable: true,
				});
			else await ctx.emit(step.msg);
		}
	},
});
