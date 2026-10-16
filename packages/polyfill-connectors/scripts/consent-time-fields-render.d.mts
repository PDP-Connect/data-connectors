// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Types for consent-time-fields-render.mjs, which stays plain JavaScript so
// the artifact input hash can import it at any commit.

export declare const DATE_BOUND_STREAMS: ReadonlySet<string>;
export declare const AGGREGATE_FILE: string;
export declare const SLICE_DIRECTORY: string;
export declare function sliceFileName(connector: string): string;
export declare function checkpointParentsOf(
	manifest: { readonly streams?: readonly unknown[] },
	connector?: string,
): Record<string, string[]>;
export declare function renderAggregate(
	connectors: Iterable<readonly [string, object]>,
): string;
export declare function renderSlice(
	connector: string,
	manifest: object,
): string;
