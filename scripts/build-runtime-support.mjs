// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const entryPoint = resolve(root, "packages/runtime-support/index.ts");
const outFile = resolve(root, "dist/runtime-support.mjs");
const typesFile = resolve(root, "dist/runtime-support.d.ts");
const buildInfoFile = resolve(root, "dist/runtime-support.buildinfo.json");

await mkdir(dirname(outFile), { recursive: true });

const result = await build({
	bundle: true,
	entryPoints: [entryPoint],
	format: "esm",
	logLevel: "info",
	metafile: true,
	outfile: outFile,
	platform: "node",
	target: "node20",
});

const inputHashes = Object.fromEntries(
	await Promise.all(
		Object.keys(result.metafile.inputs)
			.sort()
			.map(async (input) => {
				const bytes = await readFile(resolve(root, input));
				return [input, createHash("sha256").update(bytes).digest("hex")];
			}),
	),
);

await writeFile(
	buildInfoFile,
	`${JSON.stringify(
		{
			inputHashes,
			inputs: Object.keys(result.metafile.inputs).sort(),
		},
		null,
		2,
	)}\n`,
	"utf8",
);

await writeFile(
	typesFile,
	`// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export interface ManualUploadValidationOptions {
  readonly fileName?: string | null;
  readonly existingFileHashes?: readonly string[];
  readonly maxFileBytes?: number | null;
}

export interface ManualUploadFileValidationOptions {
  readonly fileName: string;
  readonly filePath: string;
  readonly fileSha256: string;
  readonly existingFileHashes?: readonly string[];
  readonly maxFileBytes?: number | null;
}

export type ManualUploadValidationResult = Readonly<{
  status: string;
  code?: string;
  detected_format?: string;
  duplicate_of_sha256?: string;
  estimated_records?: number;
  file_sha256?: string;
  kind?: string;
  reason?: string;
  rejected_reason?: string;
  [key: string]: unknown;
}>;

export declare function validateManualUploadArtifactByKind(
  kind: string | null,
  input: Buffer | Uint8Array | string,
  options?: ManualUploadValidationOptions,
): ManualUploadValidationResult | null;

export declare function validateManualUploadArtifactFromFileByKind(
  kind: string | null,
  fd: number,
  fileSize: number,
  options: ManualUploadFileValidationOptions,
): Promise<ManualUploadValidationResult | null>;

export interface ProviderAuthManifestLike {
  readonly capabilities?: {
    readonly auth?: {
      readonly authorization_params?: Readonly<Record<string, string>> | null;
      readonly authorization_url?: string | null;
      readonly deployment_config?: readonly (string | Readonly<Record<string, unknown>>)[] | null;
      readonly exchanger_kind?: string | null;
      readonly provider_identity_group?: string | null;
      readonly scopes?: readonly string[] | null;
      readonly token_url?: string | null;
      readonly userinfo_url?: string | null;
      readonly [key: string]: unknown;
    } | null;
  } | null;
  readonly connector_id?: string | null;
  readonly connector_key?: string | null;
}

export type DeploymentConfigResolver = (args: {
  identityGroup: string;
  logicalKey: string;
  envAlias?: string | null;
}) => Promise<string | null>;

export interface ProviderAuthTokens {
  readonly accessToken: string;
  readonly expiresAt?: string | null;
  readonly refreshToken?: string | null;
  readonly tokenKind: string;
}

export interface ProviderAccount {
  readonly accountId: string;
  readonly displayLabel?: string | null;
  readonly sourceBinding?: Record<string, unknown> | null;
}

export type ProviderAuthPersistenceContext = Readonly<Record<string, unknown>>;

export interface ProviderAuthInventoryResult {
  readonly accounts: readonly ProviderAccount[];
  readonly persistenceContext?: ProviderAuthPersistenceContext;
}

export interface ProviderAuthAdapter {
  exchangeCode: (args: {
    code: string;
    redirectUri: string;
    state: string;
    manifest: ProviderAuthManifestLike;
    deploymentConfigResolver: DeploymentConfigResolver;
  }) => Promise<ProviderAuthTokens | null>;
  initiateAuthorization: (args: {
    redirectUri: string;
    state: string;
    manifest: ProviderAuthManifestLike;
    deploymentConfigResolver: DeploymentConfigResolver;
  }) => Promise<{ authorizationUrl: string }>;
  runInventoryOrTest: (args: {
    tokens: ProviderAuthTokens;
    manifest: ProviderAuthManifestLike;
  }) => Promise<ProviderAuthInventoryResult>;
  storeTokens: (args: {
    tokens: ProviderAuthTokens;
    manifest: ProviderAuthManifestLike;
    persistenceContext?: ProviderAuthPersistenceContext;
  }) => Promise<Record<string, string>>;
}

export interface DeploymentConfigEntry {
  readonly envAlias: string | null;
  readonly logicalKey: string;
}

export declare function resolveProviderAuthAdapter(
  kind: string,
): Promise<ProviderAuthAdapter | null>;
`,
	"utf8",
);
