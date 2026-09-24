// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export {
	validateManualUploadArtifactByKind,
	validateManualUploadArtifactFromFileByKind,
} from "../polyfill-connectors/src/manual-upload-validation.ts";
export type {
	ManualUploadFileValidationOptions,
	ManualUploadValidationOptions,
	ManualUploadValidationResult,
} from "../polyfill-connectors/src/manual-upload-validation.ts";

export {
	resolveProviderAuthAdapter,
} from "../polyfill-connectors/src/provider-auth-adapters.ts";
export type {
	DeploymentConfigEntry,
	DeploymentConfigResolver,
	ProviderAccount,
	ProviderAuthAdapter,
	ProviderAuthInventoryResult,
	ProviderAuthManifestLike,
	ProviderAuthPersistenceContext,
	ProviderAuthTokens,
} from "../polyfill-connectors/src/provider-auth-adapter.ts";
