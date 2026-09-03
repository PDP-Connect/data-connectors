// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { sharedHelper } from "../../src/shared-runtime.ts";

export function runBeta(): string {
	return `beta-${sharedHelper()}`;
}
