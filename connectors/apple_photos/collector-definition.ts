// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Apple Photos connector's local-collector definition.
 *
 * The connector's own declaration of how it participates in local
 * collection: its stable id, the runtime bindings it needs, and the default
 * stream set an unscoped `run` should request. See
 * `packages/polyfill-connectors/src/collector-definition.ts` for the
 * contract this satisfies.
 *
 * Pure data only — no Node built-ins, no connector runtime imports — so it
 * stays safe for the publishable `@pdpp/local-collector` build to re-export.
 *
 * This connector carries no native compiled dependency (it walks a
 * filesystem export directory and hashes/uploads file bytes with Node
 * built-ins only), so it can ship in the published npm bundle.
 */

import type { LocalCollectorDefinition } from "@pdpp/connector-protocol/collector-definition";

export const APPLE_PHOTOS_DEFAULT_STREAMS = ["photos"] as const;

/**
 * `photos` declares `file_modified_at`.
 */
export const APPLE_PHOTOS_TIME_SCOPABLE_STREAMS = ["photos"] as const;

export const applePhotosCollectorDefinition: LocalCollectorDefinition = {
	connector_id: "apple_photos",
	entry: "apple_photos",
	bindings: { filesystem: { required: true } },
	// Declared explicitly (not omitted): this definition targets the
	// connector-protocol 0.0.2 capability-declaration contract, which
	// requires an explicit array even when empty. This connector emits no
	// STREAM_EVIDENCE and needs no protocol capability today.
	protocol_capabilities: [],
	streams: APPLE_PHOTOS_DEFAULT_STREAMS,
	time_scopable_streams: APPLE_PHOTOS_TIME_SCOPABLE_STREAMS,
};
