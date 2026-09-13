// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import {
	retentionChunkSchema,
	retentionManifestPageSchema,
	retentionManifestRootSchema,
	retentionObservationSchema,
	retentionPolicySchema,
	retentionReceiptSchema,
} from "./retention-schemas.ts";

/**
 * Dormant declarations. Installing this package does not enable these streams.
 *
 * Unlike the artifact-class taxonomy, this table is deliberately *not*
 * per-connector, and is not the same kind of hardcoding `b076a2d4` removed.
 * These six names are the retention wire format's own streams, each bound to
 * the schema that validates it. They are identical for every connector:
 * adding a connector adds artifact classes, never a retention stream, so
 * there is no per-connector copy here that could drift. A connector that
 * captures bytes uses exactly these streams or it is not speaking this
 * format.
 *
 * The per-connector part of retention — which classes a connector's session
 * format can produce — lives in each connector's own `collector-definition.ts`
 * and is assembled by `CONNECTOR_RETENTION_ARTIFACT_CLASSES`.
 */
export const RETENTION_STREAMS = {
	raw_chunks: retentionChunkSchema,
	retention_manifests: retentionManifestRootSchema,
	retention_manifest_pages: retentionManifestPageSchema,
	retention_policies: retentionPolicySchema,
	retention_observations: retentionObservationSchema,
	retention_receipts: retentionReceiptSchema,
} as const;

export type RetentionStream = keyof typeof RETENTION_STREAMS;

/** Every retention stream requires compare-or-insert, not ordinary record upsert. */
export const RETENTION_REQUIRED_CAPABILITIES = [
	"blob_upload",
	"authorized_blob_read",
	"durable_record_receipts",
	"immutable_record_insert",
	"retention_checkpoint",
] as const;

const runtimeSupportSchema = z.object({
	format_versions: z.array(z.number().int().positive()),
	capabilities: z.array(z.string()),
	/** Streams both declared and granted for the current connector instance. */
	streams: z.array(z.string()),
});

export type RetentionCompatibility =
	| { available: true; format_version: 1 }
	| {
			available: false;
			reason: "retention_unavailable";
			missing: string[];
	  };

/**
 * Check an explicit installed-runtime/server advertisement before enabling capture.
 * The existing runtime does not advertise this contract; absent support fails closed.
 * This is negotiation only, not evidence of successful upload or durable retention.
 */
export function checkRetentionCompatibility(
	support: unknown,
): RetentionCompatibility {
	const parsed = runtimeSupportSchema.safeParse(support);
	if (!parsed.success) {
		return {
			available: false,
			reason: "retention_unavailable",
			missing: ["runtime_support"],
		};
	}
	const missing: string[] = [];
	if (!parsed.data.format_versions.includes(1)) {
		missing.push("format_version:1");
	}
	for (const capability of RETENTION_REQUIRED_CAPABILITIES) {
		if (!parsed.data.capabilities.includes(capability)) {
			missing.push(`capability:${capability}`);
		}
	}
	for (const stream of Object.keys(RETENTION_STREAMS)) {
		if (!parsed.data.streams.includes(stream)) {
			missing.push(`stream:${stream}`);
		}
	}
	return missing.length === 0
		? { available: true, format_version: 1 }
		: { available: false, reason: "retention_unavailable", missing };
}
