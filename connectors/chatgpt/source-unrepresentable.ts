// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The ONE place that names how a permanent, source-unrepresentable loss is
 * reported. Today that is a Vana-only, non-portable stopgap: the conversation
 * is neither hydrated nor gapped but listed in DETAIL_COVERAGE
 * `optional_skip_keys`, with no retryable DETAIL_GAP (a refetch returns the same
 * bytes).
 *
 * Only two cases use it, both permanent: the unknown-content-shape fallback
 * that cuts a body to FALLBACK_MAX_CHARS (`ExtractedContent.sourceUnrepresentable`),
 * and message text whose JSON encoding exceeds the host blob limit (32 MiB, so
 * no host can store it). Control characters and text up to the blob limit are
 * representable (escape encoding, Core blob) and must never come through here.
 *
 * TODO(pdpp-runtime-permanent-gap): replace with DETAIL_GAP{retryable:false, reason:"source_unrepresentable"} + gap_keys once the build loop's runtime change lands; then remove optional_skip_keys.
 */

/** Outcome of one conversation detail whose body the source cannot represent. */
export type SourceUnrepresentableOutcome = {
	complete: false;
	permanent: true;
};

// TODO(pdpp-runtime-permanent-gap): replace with DETAIL_GAP{retryable:false, reason:"source_unrepresentable"} + gap_keys once the build loop's runtime change lands; then remove optional_skip_keys.
export const SOURCE_UNREPRESENTABLE_OUTCOME: SourceUnrepresentableOutcome = {
	complete: false,
	permanent: true,
};

export function isSourceUnrepresentable(
	outcome: object,
): outcome is SourceUnrepresentableOutcome {
	return "permanent" in outcome;
}

/**
 * Keys to declare as DETAIL_COVERAGE `optional_skip_keys`.
 *
 * TODO(pdpp-runtime-permanent-gap): replace with DETAIL_GAP{retryable:false, reason:"source_unrepresentable"} + gap_keys once the build loop's runtime change lands; then remove optional_skip_keys.
 */
export function optionalSkipKeysFor(
	sourceUnrepresentableKeys: Array<string | number>,
): Array<string | number> {
	return sourceUnrepresentableKeys;
}
