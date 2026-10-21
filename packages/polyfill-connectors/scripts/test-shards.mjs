// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const SHARD_SPEC = /^([1-9][0-9]*)\/([1-9][0-9]*)$/;

export function selectTestShard(files, rawShard) {
	if (rawShard === undefined || rawShard === "") return files;
	const match = SHARD_SPEC.exec(rawShard);
	if (!match) {
		throw new Error(
			`TEST_SHARD must be a positive index/count pair, got ${JSON.stringify(rawShard)}`,
		);
	}
	const index = Number(match[1]) - 1;
	const count = Number(match[2]);
	if (
		!Number.isSafeInteger(index) ||
		!Number.isSafeInteger(count) ||
		index >= count
	) {
		throw new Error(
			`TEST_SHARD index must be between 1 and its count, got ${JSON.stringify(rawShard)}`,
		);
	}

	return [...files]
		.sort()
		.filter((_, fileIndex) => fileIndex % count === index);
}
