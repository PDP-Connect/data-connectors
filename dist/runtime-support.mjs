var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// packages/polyfill-connectors/src/provider-auth-adapter.ts
function manifestAuth(manifest) {
  return manifest.capabilities?.auth ?? null;
}
function identityGroup(manifest) {
  const raw = manifestAuth(manifest)?.provider_identity_group;
  const declared = typeof raw === "string" ? raw.trim() : "";
  return declared || manifest.connector_key?.trim() || manifest.connector_id?.trim() || "";
}
function readTrimmed(record, ...keys) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}
function deploymentConfigEntry(entry) {
  if (typeof entry === "string") {
    return entry.trim() ? { envAlias: null, logicalKey: entry.trim() } : null;
  }
  if (!(entry && typeof entry === "object")) {
    return null;
  }
  const record = entry;
  const logicalKey = readTrimmed(record, "logical_key", "key");
  return logicalKey ? { envAlias: readTrimmed(record, "env_alias"), logicalKey } : null;
}
function deploymentConfigEntries(manifest) {
  const declared = manifestAuth(manifest)?.deployment_config;
  if (!Array.isArray(declared)) {
    return [];
  }
  return declared.map(deploymentConfigEntry).filter((value) => value !== null);
}
function findDeploymentEntry(entries, logicalKey) {
  return entries.find((entry) => entry.logicalKey === logicalKey) ?? null;
}
function registerProviderAuthAdapter(kind, adapter) {
  if (adapters.has(kind)) {
    throw new Error(`provider_auth_adapter_kind_duplicate: ${kind}`);
  }
  adapters.set(kind, adapter);
}
function getRegisteredProviderAuthAdapter(kind) {
  return adapters.get(kind) ?? null;
}
var adapters;
var init_provider_auth_adapter = __esm({
  "packages/polyfill-connectors/src/provider-auth-adapter.ts"() {
    "use strict";
    adapters = /* @__PURE__ */ new Map();
  }
});

// packages/polyfill-connectors/src/oauth2-generic-provider-auth.ts
var oauth2_generic_provider_auth_exports = {};
__export(oauth2_generic_provider_auth_exports, {
  OAUTH2_GENERIC_EXCHANGER_KIND: () => OAUTH2_GENERIC_EXCHANGER_KIND,
  Oauth2GenericProviderAuthError: () => Oauth2GenericProviderAuthError,
  oauth2GenericAdapter: () => oauth2GenericAdapter
});
async function resolveDeploymentValue(resolver, manifest, entry) {
  const value = await resolver({
    envAlias: entry.envAlias,
    identityGroup: identityGroup(manifest),
    logicalKey: entry.logicalKey
  });
  if (!value) {
    throw new Oauth2GenericProviderAuthError(
      "oauth2_generic_provider_config_missing",
      `Provider app config '${entry.logicalKey}' is missing.`,
      503
    );
  }
  return value;
}
function requireManifestUrl(manifest, field) {
  const value = manifestAuth(manifest)?.[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Oauth2GenericProviderAuthError(
      "oauth2_generic_manifest_field_missing",
      `Connector manifest capabilities.auth.${field} is missing or empty.`,
      500
    );
  }
  return value.trim();
}
function manifestScopes(manifest) {
  const scopes = manifestAuth(manifest)?.scopes;
  return Array.isArray(scopes) ? scopes.filter(
    (scope) => typeof scope === "string" && scope.length > 0
  ) : [];
}
function manifestAuthorizationParams(manifest) {
  const params = manifestAuth(manifest)?.authorization_params;
  if (!params || typeof params !== "object") {
    return {};
  }
  const entries = Object.entries(params).filter(
    (entry) => typeof entry[1] === "string"
  );
  return Object.fromEntries(entries);
}
function nowPlusSeconds(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return new Date(Date.now() + Math.floor(seconds) * 1e3).toISOString();
}
function asObject2(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function asString2(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
async function exchangeAuthorizationCode({
  clientId,
  clientSecret,
  code,
  fetchImpl,
  redirectUri,
  tokenUrl
}) {
  const response = await fetchImpl(tokenUrl, {
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST"
  });
  const text = await response.text();
  const body = text ? asObject2(JSON.parse(text)) : {};
  if (!response.ok) {
    return null;
  }
  const accessToken = asString2(body.access_token);
  if (!accessToken) {
    return null;
  }
  return {
    accessToken,
    expiresAt: nowPlusSeconds(body.expires_in),
    refreshToken: asString2(body.refresh_token),
    tokenKind: asString2(body.token_type) ?? "Bearer"
  };
}
async function fetchUserinfo(userinfoUrl, accessToken, fetchImpl) {
  const response = await fetchImpl(userinfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    throw new Oauth2GenericProviderAuthError(
      "oauth2_generic_userinfo_failed",
      `Provider userinfo request failed with status ${response.status}.`,
      502
    );
  }
  const body = asObject2(JSON.parse(await response.text()));
  return { email: asString2(body.email), id: asString2(body.id) };
}
function tokenBundleToGenericFields(tokens) {
  return {
    access_token: tokens.accessToken,
    expires_at: tokens.expiresAt ?? "",
    refresh_token: tokens.refreshToken ?? "",
    token_kind: tokens.tokenKind
  };
}
var Oauth2GenericProviderAuthError, defaultFetchImpl, OAUTH2_GENERIC_EXCHANGER_KIND, oauth2GenericAdapter;
var init_oauth2_generic_provider_auth = __esm({
  "packages/polyfill-connectors/src/oauth2-generic-provider-auth.ts"() {
    "use strict";
    init_provider_auth_adapter();
    Oauth2GenericProviderAuthError = class extends Error {
      code;
      status;
      constructor(code, message, status = 400) {
        super(message);
        this.name = "Oauth2GenericProviderAuthError";
        this.code = code;
        this.status = status;
      }
    };
    defaultFetchImpl = (url, init) => fetch(url, init);
    OAUTH2_GENERIC_EXCHANGER_KIND = "oauth2_generic";
    oauth2GenericAdapter = {
      async exchangeCode({
        code,
        deploymentConfigResolver,
        manifest,
        redirectUri
      }) {
        const entries = deploymentConfigEntries(manifest);
        const [clientIdEntry, clientSecretEntry] = entries;
        if (!(clientIdEntry && clientSecretEntry)) {
          throw new Oauth2GenericProviderAuthError(
            "oauth2_generic_manifest_field_missing",
            "Connector manifest capabilities.auth.deployment_config must declare at least a client id and client secret key.",
            500
          );
        }
        const [clientId, clientSecret] = await Promise.all([
          resolveDeploymentValue(deploymentConfigResolver, manifest, clientIdEntry),
          resolveDeploymentValue(
            deploymentConfigResolver,
            manifest,
            clientSecretEntry
          )
        ]);
        return exchangeAuthorizationCode({
          clientId,
          clientSecret,
          code,
          fetchImpl: defaultFetchImpl,
          redirectUri,
          tokenUrl: requireManifestUrl(manifest, "token_url")
        });
      },
      async initiateAuthorization({
        deploymentConfigResolver,
        manifest,
        redirectUri,
        state
      }) {
        const entries = deploymentConfigEntries(manifest);
        const [clientIdEntry] = entries;
        if (!clientIdEntry) {
          throw new Oauth2GenericProviderAuthError(
            "oauth2_generic_manifest_field_missing",
            "Connector manifest capabilities.auth.deployment_config must declare at least a client id key.",
            500
          );
        }
        const clientId = await resolveDeploymentValue(
          deploymentConfigResolver,
          manifest,
          clientIdEntry
        );
        const scopes = manifestScopes(manifest);
        const url = new URL(requireManifestUrl(manifest, "authorization_url"));
        url.searchParams.set("client_id", clientId);
        url.searchParams.set("redirect_uri", redirectUri);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("scope", scopes.join(" "));
        url.searchParams.set("state", state);
        for (const [key, value] of Object.entries(
          manifestAuthorizationParams(manifest)
        )) {
          url.searchParams.set(key, value);
        }
        return { authorizationUrl: url.toString() };
      },
      async runInventoryOrTest({
        manifest,
        tokens
      }) {
        if (!tokens.refreshToken) {
          throw new Oauth2GenericProviderAuthError(
            "oauth2_generic_refresh_token_missing",
            "Authorization completed, but no refresh_token was returned. Re-authorize with the manifest's declared consent parameters \u2014 a refresh_token is only issued on the first consent for a given client+account pair.",
            422
          );
        }
        const userinfoUrl = manifestAuth(manifest)?.userinfo_url;
        if (typeof userinfoUrl !== "string" || !userinfoUrl.trim()) {
          throw new Oauth2GenericProviderAuthError(
            "oauth2_generic_manifest_field_missing",
            "Connector manifest capabilities.auth.userinfo_url is missing or empty.",
            500
          );
        }
        const { email, id } = await fetchUserinfo(
          userinfoUrl.trim(),
          tokens.accessToken,
          defaultFetchImpl
        );
        const accountId = id ?? email;
        if (!accountId) {
          throw new Oauth2GenericProviderAuthError(
            "oauth2_generic_identity_unavailable",
            "Authorization completed, but no account identity (id or email) was returned.",
            422
          );
        }
        return {
          accounts: [
            {
              accountId,
              displayLabel: email ?? accountId,
              sourceBinding: {
                account_email: email,
                account_id_verified: true
              }
            }
          ]
        };
      },
      async storeTokens({ tokens }) {
        return tokenBundleToGenericFields(tokens);
      }
    };
  }
});

// connectors/google_maps_data_portability/api.ts
function cleanBaseUrl(value) {
  return (value || DEFAULT_BASE_URL).replace(TRAILING_SLASHES, "");
}
function assertAccessToken(value) {
  if (!value.trim()) {
    throw new Error("google_data_portability_access_token_missing");
  }
  return value.trim();
}
function assertResources(resources) {
  const unique = [
    ...new Set(resources.map((item) => item.trim()).filter(Boolean))
  ];
  if (unique.length === 0) {
    throw new Error("google_data_portability_resources_missing");
  }
  return unique;
}
function asObject3(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function asString3(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function asStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
function snippet(value) {
  return value.slice(0, 500);
}
var DEFAULT_BASE_URL, TRAILING_SLASHES, GOOGLE_MAPS_DATA_PORTABILITY_RESOURCE_GROUPS, GOOGLE_MAPS_DATA_PORTABILITY_OAUTH_SCOPES, DataPortabilityApiError, GoogleDataPortabilityClient;
var init_api = __esm({
  "connectors/google_maps_data_portability/api.ts"() {
    DEFAULT_BASE_URL = "https://dataportability.googleapis.com/v1";
    TRAILING_SLASHES = /\/+$/;
    GOOGLE_MAPS_DATA_PORTABILITY_RESOURCE_GROUPS = Object.freeze([
      "maps.aliased_places",
      "maps.commute_routes",
      "maps.commute_settings",
      "maps.ev_profile",
      "maps.factual_contributions",
      "maps.offering_contributions",
      "maps.photos_videos",
      "maps.questions_answers",
      "maps.reviews",
      "maps.starred_places",
      "maps.vehicle_profile",
      "myactivity.maps",
      "mymaps.maps"
    ]);
    GOOGLE_MAPS_DATA_PORTABILITY_OAUTH_SCOPES = Object.freeze(
      GOOGLE_MAPS_DATA_PORTABILITY_RESOURCE_GROUPS.map(
        (resourceGroup) => `https://www.googleapis.com/auth/dataportability.${resourceGroup}`
      )
    );
    DataPortabilityApiError = class extends Error {
      bodySnippet;
      status;
      constructor(status, bodySnippet) {
        super(`google_data_portability_api_error: ${status}`);
        this.name = "DataPortabilityApiError";
        this.status = status;
        this.bodySnippet = bodySnippet;
      }
    };
    GoogleDataPortabilityClient = class {
      accessToken;
      baseUrl;
      fetchImpl;
      constructor(options) {
        this.accessToken = assertAccessToken(options.accessToken);
        this.baseUrl = cleanBaseUrl(options.baseUrl);
        this.fetchImpl = options.fetch ?? fetch;
      }
      async checkAccessType() {
        const body = asObject3(
          await this.request("/accessType:check", { method: "POST" })
        );
        return {
          oneTimeResources: asStringArray(body.oneTimeResources),
          timeBasedResources: asStringArray(body.timeBasedResources)
        };
      }
      async initiateArchive(input) {
        const payload = {
          resources: assertResources(input.resources)
        };
        if (input.startTime) {
          payload.startTime = input.startTime;
        }
        if (input.endTime) {
          payload.endTime = input.endTime;
        }
        const body = asObject3(
          await this.request("/portabilityArchive:initiate", {
            body: JSON.stringify(payload),
            method: "POST"
          })
        );
        const archiveJobId = asString3(body.archiveJobId);
        if (!archiveJobId) {
          throw new Error("google_data_portability_archive_job_id_missing");
        }
        return {
          accessType: asString3(body.accessType),
          archiveJobId
        };
      }
      async getArchiveState(archiveJobId) {
        const jobId = asString3(archiveJobId);
        if (!jobId) {
          throw new Error("google_data_portability_archive_job_id_missing");
        }
        const name = `archiveJobs/${encodeURIComponent(jobId)}/portabilityArchiveState`;
        const body = asObject3(await this.request(`/${name}`, { method: "GET" }));
        const state = asString3(body.state);
        if (!state) {
          throw new Error("google_data_portability_archive_state_missing");
        }
        return {
          exportTime: asString3(body.exportTime),
          name: asString3(body.name) ?? name,
          startTime: asString3(body.startTime),
          state,
          urls: asStringArray(body.urls)
        };
      }
      async request(path, init) {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
            ...init.headers ?? {}
          }
        });
        const text = await response.text();
        if (!response.ok) {
          throw new DataPortabilityApiError(response.status, snippet(text));
        }
        return text ? JSON.parse(text) : {};
      }
    };
  }
});

// connectors/google_maps_data_portability/provider-auth.ts
var provider_auth_exports = {};
__export(provider_auth_exports, {
  GOOGLE_DATA_PORTABILITY_EXCHANGER_KIND: () => GOOGLE_DATA_PORTABILITY_EXCHANGER_KIND,
  GoogleDataPortabilityProviderAuthError: () => GoogleDataPortabilityProviderAuthError,
  googleDataPortabilityAdapter: () => googleDataPortabilityAdapter
});
import { createHash as createHash8 } from "node:crypto";
async function resolveDeploymentValue2(resolver, manifest, entry) {
  const value = await resolver({
    envAlias: entry.envAlias,
    identityGroup: identityGroup(manifest),
    logicalKey: entry.logicalKey
  });
  if (!value) {
    throw new GoogleDataPortabilityProviderAuthError(
      "google_dataportability_provider_config_missing",
      `Google Data Portability provider app config '${entry.logicalKey}' is missing.`,
      503
    );
  }
  return value;
}
function requireManifestUrl2(manifest, field) {
  const value = manifestAuth(manifest)?.[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new GoogleDataPortabilityProviderAuthError(
      "google_dataportability_manifest_field_missing",
      `Connector manifest capabilities.auth.${field} is missing or empty.`,
      500
    );
  }
  return value.trim();
}
function manifestResourceGroups(manifest) {
  const declared = manifestAuth(manifest)?.resource_groups;
  const allowed = new Set(GOOGLE_MAPS_DATA_PORTABILITY_RESOURCE_GROUPS);
  if (!Array.isArray(declared)) {
    return GOOGLE_MAPS_DATA_PORTABILITY_RESOURCE_GROUPS;
  }
  const unique = [
    ...new Set(
      declared.filter(
        (item) => typeof item === "string" && item.trim().length > 0
      )
    )
  ].map((item) => item.trim());
  const unsupported = unique.filter((item) => !allowed.has(item));
  if (unsupported.length > 0) {
    throw new GoogleDataPortabilityProviderAuthError(
      "google_dataportability_resource_group_unsupported",
      `Unsupported Google Data Portability Maps resource group: ${unsupported.join(", ")}.`,
      500
    );
  }
  return unique.length > 0 ? unique : GOOGLE_MAPS_DATA_PORTABILITY_RESOURCE_GROUPS;
}
function scopesForResourceGroups(resourceGroups) {
  return resourceGroups.map(
    (resourceGroup) => `https://www.googleapis.com/auth/dataportability.${resourceGroup}`
  );
}
function tokenAccountFingerprint(tokens, resourceGroups) {
  return createHash8("sha256").update(tokens.refreshToken || tokens.accessToken).update("\n").update([...resourceGroups].sort().join(",")).digest("hex").slice(0, 20);
}
function nowPlusSeconds2(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return new Date(Date.now() + Math.floor(seconds) * 1e3).toISOString();
}
function asObject4(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function asString4(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function intersectOrdered(values, allowed) {
  return values.filter((value) => allowed.has(value));
}
function buildAccessTypeSnapshot(resourceGroups, result) {
  const requested = new Set(resourceGroups);
  const oneTimeResourceGroups = intersectOrdered(
    result.oneTimeResources,
    requested
  );
  const timeBasedResourceGroups = intersectOrdered(
    result.timeBasedResources,
    requested
  );
  const authorized = /* @__PURE__ */ new Set([
    ...oneTimeResourceGroups,
    ...timeBasedResourceGroups
  ]);
  const deniedResourceGroups = resourceGroups.filter(
    (resourceGroup) => !authorized.has(resourceGroup)
  );
  return {
    deniedResourceGroups,
    oneTimeResourceGroups,
    timeBasedResourceGroups
  };
}
function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function readAccessTypeSnapshot(context) {
  if (!context) {
    return null;
  }
  const {
    deniedResourceGroups,
    oneTimeResourceGroups,
    timeBasedResourceGroups
  } = context;
  if (!(isStringArray(deniedResourceGroups) && isStringArray(oneTimeResourceGroups) && isStringArray(timeBasedResourceGroups))) {
    return null;
  }
  return {
    deniedResourceGroups,
    oneTimeResourceGroups,
    timeBasedResourceGroups
  };
}
async function exchangeGoogleCode({
  clientId,
  clientSecret,
  code,
  fetchImpl,
  redirectUri,
  tokenUrl
}) {
  const response = await fetchImpl(tokenUrl, {
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST"
  });
  const text = await response.text();
  const body = text ? asObject4(JSON.parse(text)) : {};
  if (!response.ok) {
    return null;
  }
  const accessToken = asString4(body.access_token);
  if (!accessToken) {
    return null;
  }
  return {
    accessToken,
    expiresAt: nowPlusSeconds2(body.expires_in),
    refreshToken: asString4(body.refresh_token),
    tokenKind: asString4(body.token_type) ?? "Bearer"
  };
}
var GoogleDataPortabilityProviderAuthError, defaultFetchImpl2, GOOGLE_DATA_PORTABILITY_EXCHANGER_KIND, googleDataPortabilityAdapter;
var init_provider_auth = __esm({
  "connectors/google_maps_data_portability/provider-auth.ts"() {
    init_provider_auth_adapter();
    init_api();
    GoogleDataPortabilityProviderAuthError = class extends Error {
      code;
      status;
      constructor(code, message, status = 400) {
        super(message);
        this.name = "GoogleDataPortabilityProviderAuthError";
        this.code = code;
        this.status = status;
      }
    };
    defaultFetchImpl2 = (url, init) => fetch(url, init);
    GOOGLE_DATA_PORTABILITY_EXCHANGER_KIND = "oauth2_access_type_resource_groups";
    googleDataPortabilityAdapter = {
      async exchangeCode({
        code,
        deploymentConfigResolver,
        manifest,
        redirectUri
      }) {
        const entries = deploymentConfigEntries(manifest);
        const clientIdEntry = findDeploymentEntry(entries, "client_id");
        const clientSecretEntry = findDeploymentEntry(entries, "client_secret");
        if (!(clientIdEntry && clientSecretEntry)) {
          throw new GoogleDataPortabilityProviderAuthError(
            "google_dataportability_manifest_field_missing",
            "Connector manifest capabilities.auth.deployment_config must declare 'client_id' and 'client_secret'.",
            500
          );
        }
        const [clientId, clientSecret] = await Promise.all([
          resolveDeploymentValue2(deploymentConfigResolver, manifest, clientIdEntry),
          resolveDeploymentValue2(
            deploymentConfigResolver,
            manifest,
            clientSecretEntry
          )
        ]);
        return exchangeGoogleCode({
          clientId,
          clientSecret,
          code,
          fetchImpl: defaultFetchImpl2,
          redirectUri,
          tokenUrl: requireManifestUrl2(manifest, "token_url")
        });
      },
      async initiateAuthorization({
        deploymentConfigResolver,
        manifest,
        redirectUri,
        state
      }) {
        const entries = deploymentConfigEntries(manifest);
        const clientIdEntry = findDeploymentEntry(entries, "client_id");
        if (!clientIdEntry) {
          throw new GoogleDataPortabilityProviderAuthError(
            "google_dataportability_manifest_field_missing",
            "Connector manifest capabilities.auth.deployment_config must declare 'client_id'.",
            500
          );
        }
        const clientId = await resolveDeploymentValue2(
          deploymentConfigResolver,
          manifest,
          clientIdEntry
        );
        const resourceGroups = manifestResourceGroups(manifest);
        const url = new URL(requireManifestUrl2(manifest, "authorization_url"));
        url.searchParams.set("client_id", clientId);
        url.searchParams.set("redirect_uri", redirectUri);
        url.searchParams.set("response_type", "code");
        url.searchParams.set(
          "scope",
          scopesForResourceGroups(resourceGroups).join(" ")
        );
        url.searchParams.set("state", state);
        const authorizationParams = manifestAuth(manifest)?.authorization_params;
        if (authorizationParams && typeof authorizationParams === "object") {
          for (const [key, value] of Object.entries(authorizationParams)) {
            if (typeof value === "string") {
              url.searchParams.set(key, value);
            }
          }
        }
        return { authorizationUrl: url.toString() };
      },
      async runInventoryOrTest({
        manifest,
        tokens
      }) {
        const resourceGroups = manifestResourceGroups(manifest);
        const client = new GoogleDataPortabilityClient({
          accessToken: tokens.accessToken,
          fetch: defaultFetchImpl2
        });
        const snapshot = buildAccessTypeSnapshot(
          resourceGroups,
          await client.checkAccessType()
        );
        const authorizedResourceGroups = [
          ...snapshot.oneTimeResourceGroups,
          ...snapshot.timeBasedResourceGroups
        ];
        if (authorizedResourceGroups.length === 0) {
          throw new GoogleDataPortabilityProviderAuthError(
            "google_dataportability_no_authorized_resources",
            "Google authorization completed, but no requested Maps Data Portability resource groups were authorized.",
            422
          );
        }
        const fingerprint = tokenAccountFingerprint(
          tokens,
          authorizedResourceGroups
        );
        return {
          accounts: [
            {
              accountId: `google_dataportability_${fingerprint}`,
              displayLabel: `Google Data Portability authorization ${fingerprint.slice(0, 8)}`,
              sourceBinding: {
                account_id_verified: false,
                authorized_resource_groups: authorizedResourceGroups,
                denied_resource_groups: snapshot.deniedResourceGroups,
                one_time_resource_groups: snapshot.oneTimeResourceGroups,
                time_based_resource_groups: snapshot.timeBasedResourceGroups
              }
            }
          ],
          persistenceContext: {
            deniedResourceGroups: snapshot.deniedResourceGroups,
            oneTimeResourceGroups: snapshot.oneTimeResourceGroups,
            timeBasedResourceGroups: snapshot.timeBasedResourceGroups
          }
        };
      },
      async storeTokens({ persistenceContext, tokens }) {
        const snapshot = readAccessTypeSnapshot(persistenceContext);
        if (!snapshot) {
          throw new GoogleDataPortabilityProviderAuthError(
            "google_dataportability_access_type_missing",
            "Google Data Portability token access-type inventory was not available for storage.",
            500
          );
        }
        return {
          access_token: tokens.accessToken,
          authorized_resource_groups: [
            ...snapshot.oneTimeResourceGroups,
            ...snapshot.timeBasedResourceGroups
          ].join(","),
          denied_resource_groups: snapshot.deniedResourceGroups.join(","),
          expires_at: tokens.expiresAt ?? "",
          one_time_resource_groups: snapshot.oneTimeResourceGroups.join(","),
          time_based_resource_groups: snapshot.timeBasedResourceGroups.join(","),
          token_kind: tokens.tokenKind
        };
      }
    };
  }
});

// connectors/apple_health/validation.ts
import {
  closeSync as closeSync2,
  mkdtempSync,
  openSync as openSync2,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// packages/polyfill-connectors/src/bounded-zip-archive.ts
import { createWriteStream, readSync } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw, inflateRawSync } from "node:zlib";
var ZIP_EOCD_SIGNATURE = 101010256;
var ZIP_CENTRAL_DIRECTORY_SIGNATURE = 33639248;
var ZIP_LOCAL_FILE_SIGNATURE = 67324752;
var ZIP_UTF8_FLAG = 2048;
var ZIP_STORE_METHOD = 0;
var ZIP_DEFLATE_METHOD = 8;
var ZIP_EOCD_MIN_LENGTH = 22;
var ZIP_EOCD_MAX_COMMENT_LENGTH = 65535;
var ZIP_CENTRAL_DIRECTORY_HEADER_LENGTH = 46;
var ZIP_LOCAL_FILE_HEADER_LENGTH = 30;
var PATH_SPLIT_RE = /[\\/]/;
var ZIP_VERSION_MADE_BY_HOST_UNIX = 3;
var POSIX_S_IFLNK = 40960;
var UNSAFE_ZIP_ENTRY_NAME_RE = /(^[/\\])|(\.\.[/\\])|(\.\.$)|(^[A-Za-z]:)|(\\\\)|\0/;
var WHITESPACE_PADDED_DOT_DOT_SEGMENT_RE = /(^|[/\\])\s*\.\.\s*($|[/\\])/;
var EOCD_SCAN_WINDOW_BYTES = ZIP_EOCD_MAX_COMMENT_LENGTH + ZIP_EOCD_MIN_LENGTH;
var ZIP_CENTRAL_DIRECTORY_MAX_RECORD_LENGTH = ZIP_CENTRAL_DIRECTORY_HEADER_LENGTH + 4096;
var ZipPolicyViolationError = class extends Error {
  code;
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
    this.name = "ZipPolicyViolationError";
  }
};
function zipBasename(path) {
  return path.split(PATH_SPLIT_RE).filter(Boolean).at(-1) ?? path;
}
function hasZipLocalFileSignature(bytes) {
  return bytes.length >= 4 && bytes.readUInt32LE(0) === ZIP_LOCAL_FILE_SIGNATURE;
}
function bufferBytesSource(bytes) {
  return {
    length: bytes.length,
    readWindow(position, length) {
      const start = Math.max(0, position);
      const end = Math.min(bytes.length, start + length);
      return end > start ? bytes.subarray(start, end) : Buffer.alloc(0);
    }
  };
}
function fileBytesSource(fd, fileSize) {
  return {
    length: fileSize,
    readWindow(position, length) {
      const start = Math.max(0, position);
      const wantLength = Math.min(length, fileSize - start);
      if (wantLength <= 0) {
        return Buffer.alloc(0);
      }
      const buf = Buffer.allocUnsafe(wantLength);
      const bytesRead = readSync(fd, buf, 0, wantLength, start);
      return bytesRead === wantLength ? buf : buf.subarray(0, bytesRead);
    }
  };
}
function findEndOfCentralDirectory(source) {
  const tailStart = Math.max(0, source.length - EOCD_SCAN_WINDOW_BYTES);
  const tail = source.readWindow(tailStart, source.length - tailStart);
  const min = Math.max(
    0,
    tail.length - ZIP_EOCD_MAX_COMMENT_LENGTH - ZIP_EOCD_MIN_LENGTH
  );
  for (let offset = tail.length - ZIP_EOCD_MIN_LENGTH; offset >= min; offset -= 1) {
    if (offset >= 0 && tail.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) {
      return { offset, tail, tailStart };
    }
  }
  return null;
}
function decodeZipName(raw, flags) {
  const isUtf8 = Math.floor(flags / ZIP_UTF8_FLAG) % 2 === 1;
  return raw.toString(isUtf8 ? "utf8" : "latin1");
}
function readCentralDirectoryRecord(bytes, offset) {
  if (offset + ZIP_CENTRAL_DIRECTORY_HEADER_LENGTH > bytes.length) {
    return null;
  }
  if (bytes.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
    return null;
  }
  const versionMadeByHost = bytes.readUInt8(offset + 5);
  const flags = bytes.readUInt16LE(offset + 8);
  const method = bytes.readUInt16LE(offset + 10);
  const compressedSize = bytes.readUInt32LE(offset + 20);
  const uncompressedSize = bytes.readUInt32LE(offset + 24);
  const fileNameLength = bytes.readUInt16LE(offset + 28);
  const extraLength = bytes.readUInt16LE(offset + 30);
  const commentLength = bytes.readUInt16LE(offset + 32);
  const externalFileAttributes = bytes.readUInt32LE(offset + 38);
  const localHeaderOffset = bytes.readUInt32LE(offset + 42);
  const nameStart = offset + ZIP_CENTRAL_DIRECTORY_HEADER_LENGTH;
  if (nameStart + fileNameLength > bytes.length) {
    return null;
  }
  const nextOffset = nameStart + fileNameLength + extraLength + commentLength;
  if (nextOffset < offset || nextOffset > bytes.length) {
    return null;
  }
  const unixMode = versionMadeByHost === ZIP_VERSION_MADE_BY_HOST_UNIX ? Math.floor(externalFileAttributes / 65536) : 0;
  const isUnixSymlink = Math.floor(unixMode / 4096) === POSIX_S_IFLNK / 4096;
  return {
    compressedSize,
    isUnixSymlink,
    localHeaderOffset,
    method,
    name: decodeZipName(
      bytes.subarray(nameStart, nameStart + fileNameLength),
      flags
    ),
    nextOffset,
    uncompressedSize
  };
}
var INFLATE_OUTPUT_LIMIT_RE = /buffer|maxOutputLength|too large/i;
function resolveCompressedSlice(source, record) {
  if (record.localHeaderOffset < 0 || record.localHeaderOffset + ZIP_LOCAL_FILE_HEADER_LENGTH > source.length) {
    throw new Error("zip_entry_local_header_invalid");
  }
  const localHeader = source.readWindow(
    record.localHeaderOffset,
    ZIP_LOCAL_FILE_HEADER_LENGTH
  );
  if (localHeader.length < ZIP_LOCAL_FILE_HEADER_LENGTH || localHeader.readUInt32LE(0) !== ZIP_LOCAL_FILE_SIGNATURE) {
    throw new Error("zip_entry_local_header_invalid");
  }
  const localNameLength = localHeader.readUInt16LE(26);
  const localExtraLength = localHeader.readUInt16LE(28);
  const dataStart = record.localHeaderOffset + ZIP_LOCAL_FILE_HEADER_LENGTH + localNameLength + localExtraLength;
  const dataEnd = dataStart + record.compressedSize;
  if (dataStart < 0 || dataEnd < dataStart || dataEnd > source.length) {
    throw new Error("zip_entry_data_out_of_bounds");
  }
  const compressed = source.readWindow(dataStart, record.compressedSize);
  if (compressed.length !== record.compressedSize) {
    throw new Error("zip_entry_data_out_of_bounds");
  }
  return compressed;
}
function resolveEffectiveCap(policy, budget) {
  const totalBudgetIsBinding = budget.remainingTotalBytes < policy.maxEntryUncompressedBytes;
  return {
    bytes: totalBudgetIsBinding ? budget.remainingTotalBytes : policy.maxEntryUncompressedBytes,
    violationCode: totalBudgetIsBinding ? "total_too_large" : "entry_too_large"
  };
}
function inflateOrStoreEntry(compressed, record, cap) {
  const boundDescription = cap.violationCode === "total_too_large" ? "the shared total" : "the per-entry cap";
  if (record.method === ZIP_STORE_METHOD) {
    if (compressed.length > cap.bytes) {
      throw new ZipPolicyViolationError(
        cap.violationCode,
        `zip entry '${record.name}' exceeds the available bounded-read budget (${cap.bytes} bytes remaining, bound by ${boundDescription})`
      );
    }
    return Buffer.from(compressed);
  }
  if (record.method === ZIP_DEFLATE_METHOD) {
    try {
      return inflateRawSync(compressed, { maxOutputLength: cap.bytes });
    } catch (err) {
      if (err instanceof Error && INFLATE_OUTPUT_LIMIT_RE.test(err.message)) {
        throw new ZipPolicyViolationError(
          cap.violationCode,
          `zip entry '${record.name}' exceeds the available bounded-read budget (${cap.bytes} bytes remaining, bound by ${boundDescription}) when inflated`,
          { cause: err }
        );
      }
      throw err;
    }
  }
  throw new Error(`unsupported_zip_compression_method:${record.method}`);
}
function makeEntryDataReader(source, record, policy, budget) {
  return () => {
    const compressed = resolveCompressedSlice(source, record);
    const cap = resolveEffectiveCap(policy, budget);
    if (cap.bytes <= 0) {
      throw new ZipPolicyViolationError(
        cap.violationCode,
        `extracting zip entry '${record.name}' would exceed the ${cap.violationCode === "total_too_large" ? "shared maxTotalUncompressedBytes" : "maxEntryUncompressedBytes"} budget`
      );
    }
    const output = inflateOrStoreEntry(compressed, record, cap);
    budget.remainingTotalBytes -= output.length;
    return output;
  };
}
function readZipEntriesFromSource(source, policy) {
  const eocd = findEndOfCentralDirectory(source);
  if (!eocd) {
    return [];
  }
  const entryCount = eocd.tail.readUInt16LE(eocd.offset + 10);
  if (entryCount > policy.maxEntries) {
    throw new ZipPolicyViolationError(
      "too_many_entries",
      `zip declares ${entryCount} entries, exceeding maxEntries (${policy.maxEntries})`
    );
  }
  const centralDirSize = eocd.tail.readUInt32LE(eocd.offset + 12);
  const centralDirStart = eocd.tail.readUInt32LE(eocd.offset + 16);
  const maxPlausibleCentralDirSize = entryCount * ZIP_CENTRAL_DIRECTORY_MAX_RECORD_LENGTH;
  if (centralDirSize > maxPlausibleCentralDirSize) {
    throw new ZipPolicyViolationError(
      "too_many_entries",
      `zip declares a central directory of ${centralDirSize} bytes for ${entryCount} entries, exceeding the plausible maximum (${maxPlausibleCentralDirSize} bytes) for that many records`
    );
  }
  const centralDirBytes = source.readWindow(centralDirStart, centralDirSize);
  let offset = 0;
  const entries = [];
  const budget = {
    remainingTotalBytes: policy.maxTotalUncompressedBytes
  };
  let declaredTotalUncompressed = 0;
  const seenNames = /* @__PURE__ */ new Set();
  for (let i = 0; i < entryCount; i += 1) {
    const record = readCentralDirectoryRecord(centralDirBytes, offset);
    if (!record) {
      break;
    }
    if (UNSAFE_ZIP_ENTRY_NAME_RE.test(record.name) || WHITESPACE_PADDED_DOT_DOT_SEGMENT_RE.test(record.name)) {
      throw new ZipPolicyViolationError(
        "unsafe_entry_name",
        `zip entry '${record.name}' has an unsafe name (path traversal, absolute path, drive/UNC root, or embedded NUL)`
      );
    }
    if (record.isUnixSymlink) {
      throw new ZipPolicyViolationError(
        "unsafe_entry_name",
        `zip entry '${record.name}' is a symlink, which this reader does not support extracting`
      );
    }
    if (seenNames.has(record.name)) {
      throw new ZipPolicyViolationError(
        "unsafe_entry_name",
        `zip declares more than one entry named '${record.name}'`
      );
    }
    seenNames.add(record.name);
    if (record.uncompressedSize > policy.maxEntryUncompressedBytes) {
      throw new ZipPolicyViolationError(
        "entry_too_large",
        `zip entry '${record.name}' declares uncompressed_size ${record.uncompressedSize}, exceeding maxEntryUncompressedBytes (${policy.maxEntryUncompressedBytes})`
      );
    }
    declaredTotalUncompressed += record.uncompressedSize;
    if (declaredTotalUncompressed > policy.maxTotalUncompressedBytes) {
      throw new ZipPolicyViolationError(
        "total_too_large",
        `zip entries declare a combined uncompressed_size exceeding maxTotalUncompressedBytes (${policy.maxTotalUncompressedBytes})`
      );
    }
    entries.push({
      compressedSize: record.compressedSize,
      data: makeEntryDataReader(source, record, policy, budget),
      name: record.name,
      uncompressedSize: record.uncompressedSize
    });
    offset = record.nextOffset;
  }
  return entries;
}
function readZipEntries(bytes, policy) {
  return readZipEntriesFromSource(bufferBytesSource(bytes), policy);
}
function readZipEntriesFromFile(fd, fileSize, policy) {
  return readZipEntriesFromSource(fileBytesSource(fd, fileSize), policy);
}
var STREAM_READ_CHUNK_BYTES = 1024 * 1024;
function findCentralDirectoryRecordByName(source, policy, entryName) {
  const eocd = findEndOfCentralDirectory(source);
  if (!eocd) {
    return null;
  }
  const entryCount = eocd.tail.readUInt16LE(eocd.offset + 10);
  if (entryCount > policy.maxEntries) {
    throw new ZipPolicyViolationError(
      "too_many_entries",
      `zip declares ${entryCount} entries, exceeding maxEntries (${policy.maxEntries})`
    );
  }
  const centralDirSize = eocd.tail.readUInt32LE(eocd.offset + 12);
  const centralDirStart = eocd.tail.readUInt32LE(eocd.offset + 16);
  const maxPlausibleCentralDirSize = entryCount * ZIP_CENTRAL_DIRECTORY_MAX_RECORD_LENGTH;
  if (centralDirSize > maxPlausibleCentralDirSize) {
    throw new ZipPolicyViolationError(
      "too_many_entries",
      `zip declares a central directory of ${centralDirSize} bytes for ${entryCount} entries, exceeding the plausible maximum (${maxPlausibleCentralDirSize} bytes) for that many records`
    );
  }
  const centralDirBytes = source.readWindow(centralDirStart, centralDirSize);
  let offset = 0;
  let declaredTotalUncompressed = 0;
  const seenNames = /* @__PURE__ */ new Set();
  let match = null;
  for (let i = 0; i < entryCount; i += 1) {
    const record = readCentralDirectoryRecord(centralDirBytes, offset);
    if (!record) {
      break;
    }
    if (UNSAFE_ZIP_ENTRY_NAME_RE.test(record.name) || WHITESPACE_PADDED_DOT_DOT_SEGMENT_RE.test(record.name)) {
      throw new ZipPolicyViolationError(
        "unsafe_entry_name",
        `zip entry '${record.name}' has an unsafe name (path traversal, absolute path, drive/UNC root, or embedded NUL)`
      );
    }
    if (record.isUnixSymlink) {
      throw new ZipPolicyViolationError(
        "unsafe_entry_name",
        `zip entry '${record.name}' is a symlink, which this reader does not support extracting`
      );
    }
    if (seenNames.has(record.name)) {
      throw new ZipPolicyViolationError(
        "unsafe_entry_name",
        `zip declares more than one entry named '${record.name}'`
      );
    }
    seenNames.add(record.name);
    if (record.uncompressedSize > policy.maxEntryUncompressedBytes) {
      throw new ZipPolicyViolationError(
        "entry_too_large",
        `zip entry '${record.name}' declares uncompressed_size ${record.uncompressedSize}, exceeding maxEntryUncompressedBytes (${policy.maxEntryUncompressedBytes})`
      );
    }
    declaredTotalUncompressed += record.uncompressedSize;
    if (declaredTotalUncompressed > policy.maxTotalUncompressedBytes) {
      throw new ZipPolicyViolationError(
        "total_too_large",
        `zip entries declare a combined uncompressed_size exceeding maxTotalUncompressedBytes (${policy.maxTotalUncompressedBytes})`
      );
    }
    if (record.name === entryName || zipBasename(record.name) === entryName) {
      match = record;
    }
    offset = record.nextOffset;
  }
  return match;
}
async function streamZipEntryToFile(fd, fileSize, entryName, destPath, policy) {
  const source = fileBytesSource(fd, fileSize);
  const record = findCentralDirectoryRecordByName(source, policy, entryName);
  if (!record) {
    return { bytesWritten: 0, found: false };
  }
  if (record.localHeaderOffset < 0 || record.localHeaderOffset + ZIP_LOCAL_FILE_HEADER_LENGTH > source.length) {
    throw new Error("zip_entry_local_header_invalid");
  }
  const localHeader = source.readWindow(
    record.localHeaderOffset,
    ZIP_LOCAL_FILE_HEADER_LENGTH
  );
  if (localHeader.length < ZIP_LOCAL_FILE_HEADER_LENGTH || localHeader.readUInt32LE(0) !== ZIP_LOCAL_FILE_SIGNATURE) {
    throw new Error("zip_entry_local_header_invalid");
  }
  const localNameLength = localHeader.readUInt16LE(26);
  const localExtraLength = localHeader.readUInt16LE(28);
  const dataStart = record.localHeaderOffset + ZIP_LOCAL_FILE_HEADER_LENGTH + localNameLength + localExtraLength;
  const dataEnd = dataStart + record.compressedSize;
  if (dataStart < 0 || dataEnd < dataStart || dataEnd > source.length) {
    throw new Error("zip_entry_data_out_of_bounds");
  }
  if (record.method !== ZIP_STORE_METHOD && record.method !== ZIP_DEFLATE_METHOD) {
    throw new Error(`unsupported_zip_compression_method:${record.method}`);
  }
  let position = dataStart;
  const compressedSource = new Readable({
    read() {
      if (position >= dataEnd) {
        this.push(null);
        return;
      }
      const wantLength = Math.min(STREAM_READ_CHUNK_BYTES, dataEnd - position);
      const chunk = source.readWindow(position, wantLength);
      if (chunk.length === 0) {
        this.push(null);
        return;
      }
      position += chunk.length;
      this.push(chunk);
    }
  });
  const cap = policy.maxEntryUncompressedBytes;
  let bytesWritten = 0;
  const capEnforcer = new Transform({
    transform(chunk, _encoding, callback) {
      bytesWritten += chunk.length;
      if (bytesWritten > cap) {
        callback(
          new ZipPolicyViolationError(
            "entry_too_large",
            `zip entry '${entryName}' exceeds the per-entry uncompressed-bytes cap (${cap})`
          )
        );
        return;
      }
      callback(null, chunk);
    }
  });
  const out = createWriteStream(destPath, { flags: "wx" });
  try {
    if (record.method === ZIP_STORE_METHOD) {
      await pipeline(compressedSource, capEnforcer, out);
    } else {
      await pipeline(compressedSource, createInflateRaw(), capEnforcer, out);
    }
    return { bytesWritten, found: true };
  } catch (err) {
    await rm(destPath, { force: true }).catch(() => void 0);
    throw err;
  }
}

// connectors/apple_health/parsers.ts
import {
  closeSync,
  createReadStream,
  existsSync,
  openSync,
  readdirSync,
  statSync
} from "node:fs";
var APPLE_HEALTH_TAG_RE = /<(WorkoutStatistics|WorkoutEvent|MetadataEntry|WorkoutRoute|Workout|Record)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>|<\/(Record|Workout)>/g;
var APPLE_HEALTH_ATTR_RE = /([\w:-]+)="([^"]*)"/g;
var XML_ENTITY_RE = /&(lt|gt|amp|quot|apos|#x[0-9a-fA-F]+|#\d+);/g;
function decodeXmlEntities(s) {
  return s.replace(XML_ENTITY_RE, (_entity, name) => {
    switch (name) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        if (name.startsWith("#x")) {
          return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
        }
        return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    }
  });
}
function parseAttrs(tag) {
  const attrs = {};
  const re = new RegExp(APPLE_HEALTH_ATTR_RE.source, "g");
  let m = re.exec(tag);
  while (m !== null) {
    const [, key, value] = m;
    if (key) {
      attrs[key] = decodeXmlEntities(value ?? "");
    }
    m = re.exec(tag);
  }
  return attrs;
}
function isoDate(v) {
  if (!v) {
    return null;
  }
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) {
    return d.toISOString();
  }
  return null;
}
var MAX_EXPORT_XML_BYTES = 8 * 1024 * 1024 * 1024;
var APPLE_HEALTH_ZIP_POLICY = {
  maxEntries: 5e3,
  maxEntryUncompressedBytes: MAX_EXPORT_XML_BYTES,
  maxTotalUncompressedBytes: MAX_EXPORT_XML_BYTES
};
var HEALTH_DATA_ROOT_RE = /<HealthData[\s>]/;
var ROOT_SNIFF_WINDOW_BYTES = 1024 * 1024;
function appleHealthZipPolicy() {
  return APPLE_HEALTH_ZIP_POLICY;
}
var SCAN_READ_BUFFER_SIZE = 65536;
function updateHealthDataRootSniff(state, buf, chunkText) {
  if (state.looksLikeHealthExport) {
    return false;
  }
  state.sniffedBytes += Buffer.byteLength(chunkText, "utf8");
  if (HEALTH_DATA_ROOT_RE.test(buf)) {
    state.looksLikeHealthExport = true;
    return false;
  }
  return state.sniffedBytes > ROOT_SNIFF_WINDOW_BYTES;
}
function recordStartDateBounds(state, startDate) {
  if (!state.earliestStartDate || startDate < state.earliestStartDate) {
    state.earliestStartDate = startDate;
  }
  if (!state.latestStartDate || startDate > state.latestStartDate) {
    state.latestStartDate = startDate;
  }
}
function applyTagMatch(state, openTag, attrString) {
  if (!(openTag === "Record" || openTag === "Workout")) {
    return;
  }
  const attrs = parseAttrs(attrString ?? "");
  const startDate = isoDate(attrs.startDate);
  if (openTag === "Record") {
    state.recordCount += 1;
  } else {
    state.workoutCount += 1;
  }
  if (startDate) {
    recordStartDateBounds(state, startDate);
  }
}
function scanTagMatches(state, buf) {
  const re = new RegExp(APPLE_HEALTH_TAG_RE.source, "g");
  let m = re.exec(buf);
  let lastEnd = 0;
  while (m !== null) {
    const [, openTag, attrString] = m;
    applyTagMatch(state, openTag, attrString);
    lastEnd = re.lastIndex;
    m = re.exec(buf);
  }
  return buf.slice(lastEnd);
}
async function scanExportXmlSummary(path) {
  const stream = createReadStream(path, {
    encoding: "utf8",
    highWaterMark: SCAN_READ_BUFFER_SIZE
  });
  const state = {
    earliestStartDate: null,
    latestStartDate: null,
    looksLikeHealthExport: false,
    recordCount: 0,
    sniffedBytes: 0,
    workoutCount: 0
  };
  let buf = "";
  for await (const chunk of stream) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    buf += text;
    if (updateHealthDataRootSniff(state, buf, text)) {
      stream.destroy();
      break;
    }
    buf = scanTagMatches(state, buf);
  }
  const {
    earliestStartDate,
    latestStartDate,
    looksLikeHealthExport,
    recordCount,
    workoutCount
  } = state;
  return {
    earliestStartDate,
    latestStartDate,
    looksLikeHealthExport,
    recordCount,
    workoutCount
  };
}

// connectors/apple_health/validation.ts
var ZIP_EXT_RE = /\.zip$/i;
var XML_EXT_RE = /\.xml$/i;
function remediationFor(status) {
  switch (status) {
    case "duplicate":
      return "This export was already imported. Produce a newer export from iPhone Health app > profile > Export All Health Data if you need more recent data.";
    case "empty":
      return "This looks like an Apple Health export, but it does not contain any records or workouts to import.";
    case "too_large":
      return "This export is larger than PDPP can safely process from a browser upload. Ask your PDPP operator to raise the upload limit, or import a smaller date range if your Health app supports it.";
    case "unsupported":
      return "Choose the .zip from Health app > profile > Export All Health Data, or the export.xml file extracted from it. Other files (Health app backups, screenshots, CSV exports from third-party apps) are not supported.";
    case "valid":
      return null;
    default:
      return null;
  }
}
function baseValidation(fileSha256) {
  return {
    date_range: { end: null, start: null },
    detected_format: "unsupported",
    estimated_records: 0,
    estimated_workouts: 0,
    file_sha256: fileSha256
  };
}
function buildValidationFromSummary(summary, detectedFormat, fileSha256, existingFileHashes) {
  if (!summary.looksLikeHealthExport) {
    return {
      ...baseValidation(fileSha256),
      remediation: remediationFor("unsupported"),
      status: "unsupported"
    };
  }
  let status = "valid";
  if (new Set(existingFileHashes ?? []).has(fileSha256)) {
    status = "duplicate";
  } else if (summary.recordCount === 0 && summary.workoutCount === 0) {
    status = "empty";
  }
  return {
    date_range: {
      end: summary.latestStartDate,
      start: summary.earliestStartDate
    },
    detected_format: detectedFormat,
    estimated_records: summary.recordCount,
    estimated_workouts: summary.workoutCount,
    file_sha256: fileSha256,
    remediation: remediationFor(status),
    status
  };
}
async function validateAppleHealthExportArtifactFromFile(fd, filePath, fileSize, options) {
  const base = baseValidation(options.fileSha256);
  if (options.maxFileBytes !== null && options.maxFileBytes !== void 0 && fileSize > options.maxFileBytes) {
    return {
      ...base,
      remediation: remediationFor("too_large"),
      status: "too_large"
    };
  }
  if (XML_EXT_RE.test(options.fileName)) {
    const summary = await scanExportXmlSummary(filePath);
    return buildValidationFromSummary(
      summary,
      "apple_health_export_xml",
      options.fileSha256,
      options.existingFileHashes
    );
  }
  if (!ZIP_EXT_RE.test(options.fileName)) {
    return {
      ...base,
      remediation: remediationFor("unsupported"),
      status: "unsupported"
    };
  }
  const scratchDir = mkdtempSync(join(tmpdir(), "pdpp-apple-health-validate-"));
  const scratchPath = join(scratchDir, "export.xml");
  try {
    const result = await streamZipEntryToFile(
      fd,
      fileSize,
      "export.xml",
      scratchPath,
      appleHealthZipPolicy()
    );
    if (!result.found) {
      return {
        ...base,
        remediation: remediationFor("unsupported"),
        status: "unsupported"
      };
    }
    const summary = await scanExportXmlSummary(scratchPath);
    return buildValidationFromSummary(
      summary,
      "apple_health_export_zip",
      options.fileSha256,
      options.existingFileHashes
    );
  } catch (err) {
    const code = err?.code;
    const isSizePolicyRejection = code === "entry_too_large" || code === "total_too_large" || code === "too_many_entries";
    return {
      ...base,
      remediation: remediationFor(
        isSizePolicyRejection ? "too_large" : "unsupported"
      ),
      status: isSizePolicyRejection ? "too_large" : "unsupported"
    };
  } finally {
    rmSync(scratchDir, { force: true, recursive: true });
  }
}

// connectors/google_maps/validation.ts
import { createHash as createHash2 } from "node:crypto";

// connectors/google_maps/archive-stream.ts
import { createReadStream as createReadStream2 } from "node:fs";

// node_modules/@streamparser/json/dist/mjs/utils/bufferedString.js
var NonBufferedString = class {
  constructor() {
    this.decoder = new TextDecoder("utf-8", { fatal: true });
    this.pending = [];
    this.string = "";
    this.byteLength = 0;
  }
  appendChar(char) {
    this.pending.push(String.fromCharCode(char));
    this.byteLength += 1;
  }
  appendBuf(buf, start = 0, end = buf.length) {
    this.pending.push(this.decoder.decode(buf.subarray(start, end)));
    this.byteLength += end - start;
  }
  appendCharCode(code) {
    this.pending.push(String.fromCharCode(code));
  }
  reset() {
    this.pending = [];
    this.string = "";
    this.byteLength = 0;
  }
  // Folds only the pieces appended since the last call into `string`, so
  // repeated calls (one per chunk when emitting partial tokens) stay linear
  // overall instead of re-joining the whole accumulated string every time.
  toString() {
    if (this.pending.length > 0) {
      this.string += this.pending.join("");
      this.pending = [];
    }
    return this.string;
  }
};
var BufferedString = class {
  /**
   * @param bufferSize The size, in bytes, of the buffer to accumulate into.
   */
  constructor(bufferSize) {
    this.decoder = new TextDecoder("utf-8", { fatal: true });
    this.bufferOffset = 0;
    this.string = "";
    this.byteLength = 0;
    this.buffer = new Uint8Array(bufferSize);
  }
  appendChar(char) {
    if (this.bufferOffset >= this.buffer.length)
      this.flushStringBuffer();
    this.buffer[this.bufferOffset++] = char;
    this.byteLength += 1;
  }
  appendBuf(buf, start = 0, end = buf.length) {
    const size = end - start;
    if (this.bufferOffset + size > this.buffer.length)
      this.flushStringBuffer();
    if (size > this.buffer.length) {
      this.string += this.decoder.decode(buf.subarray(start, end));
      this.byteLength += size;
      return;
    }
    this.buffer.set(buf.subarray(start, end), this.bufferOffset);
    this.bufferOffset += size;
    this.byteLength += size;
  }
  appendCharCode(code) {
    this.flushStringBuffer();
    this.string += String.fromCharCode(code);
  }
  flushStringBuffer() {
    this.string += this.decoder.decode(this.buffer.subarray(0, this.bufferOffset));
    this.bufferOffset = 0;
  }
  reset() {
    this.string = "";
    this.bufferOffset = 0;
    this.byteLength = 0;
  }
  toString() {
    this.flushStringBuffer();
    return this.string;
  }
};

// node_modules/@streamparser/json/dist/mjs/utils/types/tokenType.js
var TokenType;
(function(TokenType2) {
  TokenType2[TokenType2["LEFT_BRACE"] = 0] = "LEFT_BRACE";
  TokenType2[TokenType2["RIGHT_BRACE"] = 1] = "RIGHT_BRACE";
  TokenType2[TokenType2["LEFT_BRACKET"] = 2] = "LEFT_BRACKET";
  TokenType2[TokenType2["RIGHT_BRACKET"] = 3] = "RIGHT_BRACKET";
  TokenType2[TokenType2["COLON"] = 4] = "COLON";
  TokenType2[TokenType2["COMMA"] = 5] = "COMMA";
  TokenType2[TokenType2["TRUE"] = 6] = "TRUE";
  TokenType2[TokenType2["FALSE"] = 7] = "FALSE";
  TokenType2[TokenType2["NULL"] = 8] = "NULL";
  TokenType2[TokenType2["STRING"] = 9] = "STRING";
  TokenType2[TokenType2["NUMBER"] = 10] = "NUMBER";
  TokenType2[TokenType2["SEPARATOR"] = 11] = "SEPARATOR";
})(TokenType || (TokenType = {}));
var tokenType_default = TokenType;

// node_modules/@streamparser/json/dist/mjs/utils/utf-8.js
var charset;
(function(charset2) {
  charset2[charset2["BACKSPACE"] = 8] = "BACKSPACE";
  charset2[charset2["FORM_FEED"] = 12] = "FORM_FEED";
  charset2[charset2["NEWLINE"] = 10] = "NEWLINE";
  charset2[charset2["CARRIAGE_RETURN"] = 13] = "CARRIAGE_RETURN";
  charset2[charset2["TAB"] = 9] = "TAB";
  charset2[charset2["SPACE"] = 32] = "SPACE";
  charset2[charset2["EXCLAMATION_MARK"] = 33] = "EXCLAMATION_MARK";
  charset2[charset2["QUOTATION_MARK"] = 34] = "QUOTATION_MARK";
  charset2[charset2["NUMBER_SIGN"] = 35] = "NUMBER_SIGN";
  charset2[charset2["DOLLAR_SIGN"] = 36] = "DOLLAR_SIGN";
  charset2[charset2["PERCENT_SIGN"] = 37] = "PERCENT_SIGN";
  charset2[charset2["AMPERSAND"] = 38] = "AMPERSAND";
  charset2[charset2["APOSTROPHE"] = 39] = "APOSTROPHE";
  charset2[charset2["LEFT_PARENTHESIS"] = 40] = "LEFT_PARENTHESIS";
  charset2[charset2["RIGHT_PARENTHESIS"] = 41] = "RIGHT_PARENTHESIS";
  charset2[charset2["ASTERISK"] = 42] = "ASTERISK";
  charset2[charset2["PLUS_SIGN"] = 43] = "PLUS_SIGN";
  charset2[charset2["COMMA"] = 44] = "COMMA";
  charset2[charset2["HYPHEN_MINUS"] = 45] = "HYPHEN_MINUS";
  charset2[charset2["FULL_STOP"] = 46] = "FULL_STOP";
  charset2[charset2["SOLIDUS"] = 47] = "SOLIDUS";
  charset2[charset2["DIGIT_ZERO"] = 48] = "DIGIT_ZERO";
  charset2[charset2["DIGIT_ONE"] = 49] = "DIGIT_ONE";
  charset2[charset2["DIGIT_TWO"] = 50] = "DIGIT_TWO";
  charset2[charset2["DIGIT_THREE"] = 51] = "DIGIT_THREE";
  charset2[charset2["DIGIT_FOUR"] = 52] = "DIGIT_FOUR";
  charset2[charset2["DIGIT_FIVE"] = 53] = "DIGIT_FIVE";
  charset2[charset2["DIGIT_SIX"] = 54] = "DIGIT_SIX";
  charset2[charset2["DIGIT_SEVEN"] = 55] = "DIGIT_SEVEN";
  charset2[charset2["DIGIT_EIGHT"] = 56] = "DIGIT_EIGHT";
  charset2[charset2["DIGIT_NINE"] = 57] = "DIGIT_NINE";
  charset2[charset2["COLON"] = 58] = "COLON";
  charset2[charset2["SEMICOLON"] = 59] = "SEMICOLON";
  charset2[charset2["LESS_THAN_SIGN"] = 60] = "LESS_THAN_SIGN";
  charset2[charset2["EQUALS_SIGN"] = 61] = "EQUALS_SIGN";
  charset2[charset2["GREATER_THAN_SIGN"] = 62] = "GREATER_THAN_SIGN";
  charset2[charset2["QUESTION_MARK"] = 63] = "QUESTION_MARK";
  charset2[charset2["COMMERCIAL_AT"] = 64] = "COMMERCIAL_AT";
  charset2[charset2["LATIN_CAPITAL_LETTER_A"] = 65] = "LATIN_CAPITAL_LETTER_A";
  charset2[charset2["LATIN_CAPITAL_LETTER_B"] = 66] = "LATIN_CAPITAL_LETTER_B";
  charset2[charset2["LATIN_CAPITAL_LETTER_C"] = 67] = "LATIN_CAPITAL_LETTER_C";
  charset2[charset2["LATIN_CAPITAL_LETTER_D"] = 68] = "LATIN_CAPITAL_LETTER_D";
  charset2[charset2["LATIN_CAPITAL_LETTER_E"] = 69] = "LATIN_CAPITAL_LETTER_E";
  charset2[charset2["LATIN_CAPITAL_LETTER_F"] = 70] = "LATIN_CAPITAL_LETTER_F";
  charset2[charset2["LATIN_CAPITAL_LETTER_G"] = 71] = "LATIN_CAPITAL_LETTER_G";
  charset2[charset2["LATIN_CAPITAL_LETTER_H"] = 72] = "LATIN_CAPITAL_LETTER_H";
  charset2[charset2["LATIN_CAPITAL_LETTER_I"] = 73] = "LATIN_CAPITAL_LETTER_I";
  charset2[charset2["LATIN_CAPITAL_LETTER_J"] = 74] = "LATIN_CAPITAL_LETTER_J";
  charset2[charset2["LATIN_CAPITAL_LETTER_K"] = 75] = "LATIN_CAPITAL_LETTER_K";
  charset2[charset2["LATIN_CAPITAL_LETTER_L"] = 76] = "LATIN_CAPITAL_LETTER_L";
  charset2[charset2["LATIN_CAPITAL_LETTER_M"] = 77] = "LATIN_CAPITAL_LETTER_M";
  charset2[charset2["LATIN_CAPITAL_LETTER_N"] = 78] = "LATIN_CAPITAL_LETTER_N";
  charset2[charset2["LATIN_CAPITAL_LETTER_O"] = 79] = "LATIN_CAPITAL_LETTER_O";
  charset2[charset2["LATIN_CAPITAL_LETTER_P"] = 80] = "LATIN_CAPITAL_LETTER_P";
  charset2[charset2["LATIN_CAPITAL_LETTER_Q"] = 81] = "LATIN_CAPITAL_LETTER_Q";
  charset2[charset2["LATIN_CAPITAL_LETTER_R"] = 82] = "LATIN_CAPITAL_LETTER_R";
  charset2[charset2["LATIN_CAPITAL_LETTER_S"] = 83] = "LATIN_CAPITAL_LETTER_S";
  charset2[charset2["LATIN_CAPITAL_LETTER_T"] = 84] = "LATIN_CAPITAL_LETTER_T";
  charset2[charset2["LATIN_CAPITAL_LETTER_U"] = 85] = "LATIN_CAPITAL_LETTER_U";
  charset2[charset2["LATIN_CAPITAL_LETTER_V"] = 86] = "LATIN_CAPITAL_LETTER_V";
  charset2[charset2["LATIN_CAPITAL_LETTER_W"] = 87] = "LATIN_CAPITAL_LETTER_W";
  charset2[charset2["LATIN_CAPITAL_LETTER_X"] = 88] = "LATIN_CAPITAL_LETTER_X";
  charset2[charset2["LATIN_CAPITAL_LETTER_Y"] = 89] = "LATIN_CAPITAL_LETTER_Y";
  charset2[charset2["LATIN_CAPITAL_LETTER_Z"] = 90] = "LATIN_CAPITAL_LETTER_Z";
  charset2[charset2["LEFT_SQUARE_BRACKET"] = 91] = "LEFT_SQUARE_BRACKET";
  charset2[charset2["REVERSE_SOLIDUS"] = 92] = "REVERSE_SOLIDUS";
  charset2[charset2["RIGHT_SQUARE_BRACKET"] = 93] = "RIGHT_SQUARE_BRACKET";
  charset2[charset2["CIRCUMFLEX_ACCENT"] = 94] = "CIRCUMFLEX_ACCENT";
  charset2[charset2["LOW_LINE"] = 95] = "LOW_LINE";
  charset2[charset2["GRAVE_ACCENT"] = 96] = "GRAVE_ACCENT";
  charset2[charset2["LATIN_SMALL_LETTER_A"] = 97] = "LATIN_SMALL_LETTER_A";
  charset2[charset2["LATIN_SMALL_LETTER_B"] = 98] = "LATIN_SMALL_LETTER_B";
  charset2[charset2["LATIN_SMALL_LETTER_C"] = 99] = "LATIN_SMALL_LETTER_C";
  charset2[charset2["LATIN_SMALL_LETTER_D"] = 100] = "LATIN_SMALL_LETTER_D";
  charset2[charset2["LATIN_SMALL_LETTER_E"] = 101] = "LATIN_SMALL_LETTER_E";
  charset2[charset2["LATIN_SMALL_LETTER_F"] = 102] = "LATIN_SMALL_LETTER_F";
  charset2[charset2["LATIN_SMALL_LETTER_G"] = 103] = "LATIN_SMALL_LETTER_G";
  charset2[charset2["LATIN_SMALL_LETTER_H"] = 104] = "LATIN_SMALL_LETTER_H";
  charset2[charset2["LATIN_SMALL_LETTER_I"] = 105] = "LATIN_SMALL_LETTER_I";
  charset2[charset2["LATIN_SMALL_LETTER_J"] = 106] = "LATIN_SMALL_LETTER_J";
  charset2[charset2["LATIN_SMALL_LETTER_K"] = 107] = "LATIN_SMALL_LETTER_K";
  charset2[charset2["LATIN_SMALL_LETTER_L"] = 108] = "LATIN_SMALL_LETTER_L";
  charset2[charset2["LATIN_SMALL_LETTER_M"] = 109] = "LATIN_SMALL_LETTER_M";
  charset2[charset2["LATIN_SMALL_LETTER_N"] = 110] = "LATIN_SMALL_LETTER_N";
  charset2[charset2["LATIN_SMALL_LETTER_O"] = 111] = "LATIN_SMALL_LETTER_O";
  charset2[charset2["LATIN_SMALL_LETTER_P"] = 112] = "LATIN_SMALL_LETTER_P";
  charset2[charset2["LATIN_SMALL_LETTER_Q"] = 113] = "LATIN_SMALL_LETTER_Q";
  charset2[charset2["LATIN_SMALL_LETTER_R"] = 114] = "LATIN_SMALL_LETTER_R";
  charset2[charset2["LATIN_SMALL_LETTER_S"] = 115] = "LATIN_SMALL_LETTER_S";
  charset2[charset2["LATIN_SMALL_LETTER_T"] = 116] = "LATIN_SMALL_LETTER_T";
  charset2[charset2["LATIN_SMALL_LETTER_U"] = 117] = "LATIN_SMALL_LETTER_U";
  charset2[charset2["LATIN_SMALL_LETTER_V"] = 118] = "LATIN_SMALL_LETTER_V";
  charset2[charset2["LATIN_SMALL_LETTER_W"] = 119] = "LATIN_SMALL_LETTER_W";
  charset2[charset2["LATIN_SMALL_LETTER_X"] = 120] = "LATIN_SMALL_LETTER_X";
  charset2[charset2["LATIN_SMALL_LETTER_Y"] = 121] = "LATIN_SMALL_LETTER_Y";
  charset2[charset2["LATIN_SMALL_LETTER_Z"] = 122] = "LATIN_SMALL_LETTER_Z";
  charset2[charset2["LEFT_CURLY_BRACKET"] = 123] = "LEFT_CURLY_BRACKET";
  charset2[charset2["VERTICAL_LINE"] = 124] = "VERTICAL_LINE";
  charset2[charset2["RIGHT_CURLY_BRACKET"] = 125] = "RIGHT_CURLY_BRACKET";
  charset2[charset2["TILDE"] = 126] = "TILDE";
})(charset || (charset = {}));
var escapedSequences = {
  [
    34
    /* charset.QUOTATION_MARK */
  ]: 34,
  [
    92
    /* charset.REVERSE_SOLIDUS */
  ]: 92,
  [
    47
    /* charset.SOLIDUS */
  ]: 47,
  [
    98
    /* charset.LATIN_SMALL_LETTER_B */
  ]: 8,
  [
    102
    /* charset.LATIN_SMALL_LETTER_F */
  ]: 12,
  [
    110
    /* charset.LATIN_SMALL_LETTER_N */
  ]: 10,
  [
    114
    /* charset.LATIN_SMALL_LETTER_R */
  ]: 13,
  [
    116
    /* charset.LATIN_SMALL_LETTER_T */
  ]: 9
};

// node_modules/@streamparser/json/dist/mjs/tokenizer.js
var TokenizerStates;
(function(TokenizerStates2) {
  TokenizerStates2[TokenizerStates2["START"] = 0] = "START";
  TokenizerStates2[TokenizerStates2["ENDED"] = 1] = "ENDED";
  TokenizerStates2[TokenizerStates2["ERROR"] = 2] = "ERROR";
  TokenizerStates2[TokenizerStates2["TRUE1"] = 3] = "TRUE1";
  TokenizerStates2[TokenizerStates2["TRUE2"] = 4] = "TRUE2";
  TokenizerStates2[TokenizerStates2["TRUE3"] = 5] = "TRUE3";
  TokenizerStates2[TokenizerStates2["FALSE1"] = 6] = "FALSE1";
  TokenizerStates2[TokenizerStates2["FALSE2"] = 7] = "FALSE2";
  TokenizerStates2[TokenizerStates2["FALSE3"] = 8] = "FALSE3";
  TokenizerStates2[TokenizerStates2["FALSE4"] = 9] = "FALSE4";
  TokenizerStates2[TokenizerStates2["NULL1"] = 10] = "NULL1";
  TokenizerStates2[TokenizerStates2["NULL2"] = 11] = "NULL2";
  TokenizerStates2[TokenizerStates2["NULL3"] = 12] = "NULL3";
  TokenizerStates2[TokenizerStates2["STRING_DEFAULT"] = 13] = "STRING_DEFAULT";
  TokenizerStates2[TokenizerStates2["STRING_AFTER_BACKSLASH"] = 14] = "STRING_AFTER_BACKSLASH";
  TokenizerStates2[TokenizerStates2["STRING_UNICODE_DIGIT_1"] = 15] = "STRING_UNICODE_DIGIT_1";
  TokenizerStates2[TokenizerStates2["STRING_UNICODE_DIGIT_2"] = 16] = "STRING_UNICODE_DIGIT_2";
  TokenizerStates2[TokenizerStates2["STRING_UNICODE_DIGIT_3"] = 17] = "STRING_UNICODE_DIGIT_3";
  TokenizerStates2[TokenizerStates2["STRING_UNICODE_DIGIT_4"] = 18] = "STRING_UNICODE_DIGIT_4";
  TokenizerStates2[TokenizerStates2["STRING_INCOMPLETE_CHAR"] = 19] = "STRING_INCOMPLETE_CHAR";
  TokenizerStates2[TokenizerStates2["NUMBER_AFTER_INITIAL_MINUS"] = 20] = "NUMBER_AFTER_INITIAL_MINUS";
  TokenizerStates2[TokenizerStates2["NUMBER_AFTER_INITIAL_ZERO"] = 21] = "NUMBER_AFTER_INITIAL_ZERO";
  TokenizerStates2[TokenizerStates2["NUMBER_AFTER_INITIAL_NON_ZERO"] = 22] = "NUMBER_AFTER_INITIAL_NON_ZERO";
  TokenizerStates2[TokenizerStates2["NUMBER_AFTER_FULL_STOP"] = 23] = "NUMBER_AFTER_FULL_STOP";
  TokenizerStates2[TokenizerStates2["NUMBER_AFTER_DECIMAL"] = 24] = "NUMBER_AFTER_DECIMAL";
  TokenizerStates2[TokenizerStates2["NUMBER_AFTER_E"] = 25] = "NUMBER_AFTER_E";
  TokenizerStates2[TokenizerStates2["NUMBER_AFTER_E_AND_SIGN"] = 26] = "NUMBER_AFTER_E_AND_SIGN";
  TokenizerStates2[TokenizerStates2["NUMBER_AFTER_E_AND_DIGIT"] = 27] = "NUMBER_AFTER_E_AND_DIGIT";
  TokenizerStates2[TokenizerStates2["SEPARATOR"] = 28] = "SEPARATOR";
  TokenizerStates2[TokenizerStates2["BOM_OR_START"] = 29] = "BOM_OR_START";
  TokenizerStates2[TokenizerStates2["BOM"] = 30] = "BOM";
})(TokenizerStates || (TokenizerStates = {}));
function TokenizerStateToString(tokenizerState) {
  return [
    "START",
    "ENDED",
    "ERROR",
    "TRUE1",
    "TRUE2",
    "TRUE3",
    "FALSE1",
    "FALSE2",
    "FALSE3",
    "FALSE4",
    "NULL1",
    "NULL2",
    "NULL3",
    "STRING_DEFAULT",
    "STRING_AFTER_BACKSLASH",
    "STRING_UNICODE_DIGIT_1",
    "STRING_UNICODE_DIGIT_2",
    "STRING_UNICODE_DIGIT_3",
    "STRING_UNICODE_DIGIT_4",
    "STRING_INCOMPLETE_CHAR",
    "NUMBER_AFTER_INITIAL_MINUS",
    "NUMBER_AFTER_INITIAL_ZERO",
    "NUMBER_AFTER_INITIAL_NON_ZERO",
    "NUMBER_AFTER_FULL_STOP",
    "NUMBER_AFTER_DECIMAL",
    "NUMBER_AFTER_E",
    "NUMBER_AFTER_E_AND_SIGN",
    "NUMBER_AFTER_E_AND_DIGIT",
    "SEPARATOR",
    "BOM_OR_START",
    "BOM"
  ][tokenizerState];
}
var defaultOpts = {
  stringBufferSize: 0,
  numberBufferSize: 0,
  separator: void 0,
  emitPartialTokens: false
};
var TokenizerError = class _TokenizerError extends Error {
  /**
   * @param message What went wrong.
   */
  constructor(message) {
    super(message);
    Object.setPrototypeOf(this, _TokenizerError.prototype);
  }
};
function validateBufferSize(name, size) {
  if (size === void 0)
    return;
  if (!Number.isInteger(size) || size < 0) {
    throw new TokenizerError(`Invalid "${name}": ${size}. Expected a non-negative integer.`);
  }
}
function utf8SequenceLength(leadByte) {
  if (leadByte >= 194 && leadByte <= 223)
    return 2;
  if (leadByte <= 239)
    return 3;
  return 4;
}
function multiByteRunEnd(buffer, start) {
  let j = start;
  while (j < buffer.length && buffer[j] >= 128) {
    const seqLength = utf8SequenceLength(buffer[j]);
    if (j + seqLength > buffer.length)
      break;
    j += seqLength;
  }
  return j;
}
var Tokenizer = class {
  /**
   * @param opts How to tokenize. See {@linkcode TokenizerOptions}.
   */
  constructor(opts) {
    this.state = 29;
    this.bomIndex = 0;
    this.separatorIndex = 0;
    this.escapedCharsByteLength = 0;
    this.bytes_remaining = 0;
    this.bytes_in_sequence = 0;
    this.char_split_buffer = new Uint8Array(4);
    this.encoder = new TextEncoder();
    this.offset = -1;
    this.streamByteLength = 0;
    opts = Object.assign(Object.assign({}, defaultOpts), opts);
    validateBufferSize("stringBufferSize", opts.stringBufferSize);
    validateBufferSize("numberBufferSize", opts.numberBufferSize);
    this.emitPartialTokens = opts.emitPartialTokens === true;
    this.bufferedString = opts.stringBufferSize && opts.stringBufferSize > 4 ? new BufferedString(opts.stringBufferSize) : new NonBufferedString();
    this.bufferedNumber = opts.numberBufferSize && opts.numberBufferSize > 0 ? new BufferedString(opts.numberBufferSize) : new NonBufferedString();
    this.separator = opts.separator;
    this.separatorBytes = opts.separator ? this.encoder.encode(opts.separator) : void 0;
  }
  /** Whether the tokenizer is ended, and thus no longer accepting data. */
  get isEnded() {
    return this.state === 1;
  }
  // Appends the code unit decoded from one \uXXXX escape, matching
  // JSON.parse's handling of surrogates: a valid high/low surrogate pair
  // combines into one character; an unpaired high or low surrogate is kept
  // as a raw UTF-16 code unit rather than replaced or dropped (JS strings
  // are free to contain lone surrogates; only encoding them as UTF-8 bytes
  // is lossy, which is why appendCharCode -- not the encoder -- is used for
  // them).
  appendUnicodeCodeUnit(intVal) {
    if (this.highSurrogate !== void 0) {
      if (intVal >= 56320 && intVal <= 57343) {
        const unicodeString2 = String.fromCharCode(this.highSurrogate, intVal);
        const unicodeBuffer2 = this.encoder.encode(unicodeString2);
        this.bufferedString.appendBuf(unicodeBuffer2);
        this.escapedCharsByteLength += 6 - unicodeBuffer2.byteLength;
        this.highSurrogate = void 0;
        return;
      }
      this.flushPendingHighSurrogate();
    }
    if (intVal >= 55296 && intVal <= 56319) {
      this.highSurrogate = intVal;
      this.escapedCharsByteLength += 6;
      return;
    }
    if (intVal >= 56320 && intVal <= 57343) {
      this.bufferedString.appendCharCode(intVal);
      this.escapedCharsByteLength += 6;
      return;
    }
    const unicodeString = String.fromCharCode(intVal);
    const unicodeBuffer = this.encoder.encode(unicodeString);
    this.bufferedString.appendBuf(unicodeBuffer);
    this.escapedCharsByteLength += 6 - unicodeBuffer.byteLength;
  }
  flushPendingHighSurrogate() {
    if (this.highSurrogate !== void 0) {
      this.bufferedString.appendCharCode(this.highSurrogate);
      this.highSurrogate = void 0;
    }
  }
  // Stash the leading bytes of a multi-byte character split across the chunk
  // boundary; STRING_INCOMPLETE_CHAR completes it from the next chunk.
  startIncompleteChar(buffer, start) {
    this.bytes_in_sequence = utf8SequenceLength(buffer[start]);
    this.bytes_remaining = start + this.bytes_in_sequence - buffer.length;
    this.char_split_buffer.set(buffer.subarray(start));
    this.state = 19;
  }
  /**
   * Pushes the next chunk of the JSON stream into the tokenizer.
   *
   * Tokenizing happens synchronously, so every token in `input` is emitted
   * through {@linkcode Tokenizer.onToken} before this returns. A chunk may end
   * anywhere, including in the middle of a multi-byte character; the rest of it
   * is picked up from the next chunk.
   *
   * @param input The chunk to tokenize: a string, a `TypedArray`, or any
   * iterable of utf-8 byte values.
   * @throws {TokenizerError} If the data is not valid JSON and no
   * {@linkcode Tokenizer.onError} callback has been set.
   */
  write(input) {
    try {
      let buffer;
      if (input instanceof Uint8Array) {
        buffer = input;
      } else if (typeof input === "string") {
        if (this.pendingStringSurrogate !== void 0) {
          input = this.pendingStringSurrogate + input;
          this.pendingStringSurrogate = void 0;
        }
        const lastCharCode = input.charCodeAt(input.length - 1);
        if (lastCharCode >= 55296 && lastCharCode <= 56319) {
          this.pendingStringSurrogate = input[input.length - 1];
          input = input.slice(0, -1);
        }
        buffer = this.encoder.encode(input);
      } else if (ArrayBuffer.isView(input)) {
        buffer = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      } else if (input !== null && typeof input === "object" && typeof input[Symbol.iterator] === "function") {
        buffer = Uint8Array.from(input);
      } else {
        throw new TypeError("Unexpected type. The `write` function only accepts Iterables (e.g. Arrays, Sets, Generators), TypedArrays and Strings.");
      }
      for (let i = 0; i < buffer.length; i += 1) {
        const n = buffer[i];
        switch (this.state) {
          // @ts-expect-error fall through case
          case 29:
            if (n === 239) {
              this.bom = [239, 187, 191];
              this.bomIndex += 1;
              this.state = 30;
              continue;
            }
            if (input instanceof Uint16Array) {
              if (n === 254) {
                this.bom = [254, 255];
                this.bomIndex += 1;
                this.state = 30;
                continue;
              }
              if (n === 255) {
                this.bom = [255, 254];
                this.bomIndex += 1;
                this.state = 30;
                continue;
              }
            }
            if (input instanceof Uint32Array) {
              if (n === 0) {
                this.bom = [0, 0, 254, 255];
                this.bomIndex += 1;
                this.state = 30;
                continue;
              }
              if (n === 255) {
                this.bom = [255, 254, 0, 0];
                this.bomIndex += 1;
                this.state = 30;
                continue;
              }
            }
          case 0:
            this.offset += 1;
            if (this.separatorBytes && n === this.separatorBytes[0]) {
              if (this.separatorBytes.length === 1) {
                this.state = 0;
                this.onToken({
                  token: tokenType_default.SEPARATOR,
                  value: this.separator,
                  offset: this.offset + this.separatorBytes.length - 1
                });
                continue;
              }
              this.state = 28;
              continue;
            }
            if (n === 32 || n === 10 || n === 13 || n === 9) {
              continue;
            }
            if (n === 123) {
              this.onToken({
                token: tokenType_default.LEFT_BRACE,
                value: "{",
                offset: this.offset
              });
              continue;
            }
            if (n === 125) {
              this.onToken({
                token: tokenType_default.RIGHT_BRACE,
                value: "}",
                offset: this.offset
              });
              continue;
            }
            if (n === 91) {
              this.onToken({
                token: tokenType_default.LEFT_BRACKET,
                value: "[",
                offset: this.offset
              });
              continue;
            }
            if (n === 93) {
              this.onToken({
                token: tokenType_default.RIGHT_BRACKET,
                value: "]",
                offset: this.offset
              });
              continue;
            }
            if (n === 58) {
              this.onToken({
                token: tokenType_default.COLON,
                value: ":",
                offset: this.offset
              });
              continue;
            }
            if (n === 44) {
              this.onToken({
                token: tokenType_default.COMMA,
                value: ",",
                offset: this.offset
              });
              continue;
            }
            if (n === 116) {
              this.state = 3;
              continue;
            }
            if (n === 102) {
              this.state = 6;
              continue;
            }
            if (n === 110) {
              this.state = 10;
              continue;
            }
            if (n === 34) {
              this.bufferedString.reset();
              this.escapedCharsByteLength = 0;
              this.state = 13;
              continue;
            }
            if (n >= 49 && n <= 57) {
              this.bufferedNumber.reset();
              this.bufferedNumber.appendChar(n);
              this.state = 22;
              continue;
            }
            if (n === 48) {
              this.bufferedNumber.reset();
              this.bufferedNumber.appendChar(n);
              this.state = 21;
              continue;
            }
            if (n === 45) {
              this.bufferedNumber.reset();
              this.bufferedNumber.appendChar(n);
              this.state = 20;
              continue;
            }
            break;
          // STRING
          case 13:
            if (n === 34) {
              this.flushPendingHighSurrogate();
              const string = this.bufferedString.toString();
              this.state = 0;
              this.onToken({
                token: tokenType_default.STRING,
                value: string,
                offset: this.offset
              });
              this.offset += this.escapedCharsByteLength + this.bufferedString.byteLength + 1;
              continue;
            }
            if (n === 92) {
              this.state = 14;
              continue;
            }
            if (n >= 128) {
              this.flushPendingHighSurrogate();
              const runEnd = multiByteRunEnd(buffer, i);
              if (runEnd > i) {
                this.bufferedString.appendBuf(buffer, i, runEnd);
                i = runEnd - 1;
              }
              if (runEnd < buffer.length && buffer[runEnd] >= 128) {
                this.startIncompleteChar(buffer, runEnd);
                i = buffer.length - 1;
              }
              continue;
            }
            if (n >= 32) {
              this.flushPendingHighSurrogate();
              let j = i;
              while (j < buffer.length) {
                const b = buffer[j];
                if (b < 32 || b >= 128 || b === 34 || b === 92)
                  break;
                j += 1;
              }
              if (j - i >= 16) {
                this.bufferedString.appendBuf(buffer, i, j);
              } else {
                for (let k = i; k < j; k += 1)
                  this.bufferedString.appendChar(buffer[k]);
              }
              i = j - 1;
              continue;
            }
            break;
          case 19: {
            const available = Math.min(this.bytes_remaining, buffer.length - i);
            this.char_split_buffer.set(buffer.subarray(i, i + available), this.bytes_in_sequence - this.bytes_remaining);
            this.bytes_remaining -= available;
            if (this.bytes_remaining > 0) {
              i = buffer.length - 1;
              continue;
            }
            this.bufferedString.appendBuf(this.char_split_buffer, 0, this.bytes_in_sequence);
            i += available - 1;
            this.state = 13;
            continue;
          }
          case 14: {
            const controlChar = escapedSequences[n];
            if (controlChar) {
              this.flushPendingHighSurrogate();
              this.bufferedString.appendChar(controlChar);
              this.escapedCharsByteLength += 1;
              this.state = 13;
              continue;
            }
            if (n === 117) {
              this.unicode = "";
              this.state = 15;
              continue;
            }
            break;
          }
          case 15:
          case 16:
          case 17:
            if (n >= 48 && n <= 57 || n >= 65 && n <= 70 || n >= 97 && n <= 102) {
              this.unicode += String.fromCharCode(n);
              this.state += 1;
              continue;
            }
            break;
          case 18:
            if (n >= 48 && n <= 57 || n >= 65 && n <= 70 || n >= 97 && n <= 102) {
              const intVal = parseInt(this.unicode + String.fromCharCode(n), 16);
              this.appendUnicodeCodeUnit(intVal);
              this.state = 13;
              continue;
            }
            break;
          // Number
          case 20:
            if (n === 48) {
              this.bufferedNumber.appendChar(n);
              this.state = 21;
              continue;
            }
            if (n >= 49 && n <= 57) {
              this.bufferedNumber.appendChar(n);
              this.state = 22;
              continue;
            }
            break;
          case 21:
            if (n === 46) {
              this.bufferedNumber.appendChar(n);
              this.state = 23;
              continue;
            }
            if (n === 101 || n === 69) {
              this.bufferedNumber.appendChar(n);
              this.state = 25;
              continue;
            }
            i -= 1;
            this.state = 0;
            this.emitNumber();
            continue;
          case 22:
            if (n >= 48 && n <= 57) {
              this.bufferedNumber.appendChar(n);
              continue;
            }
            if (n === 46) {
              this.bufferedNumber.appendChar(n);
              this.state = 23;
              continue;
            }
            if (n === 101 || n === 69) {
              this.bufferedNumber.appendChar(n);
              this.state = 25;
              continue;
            }
            i -= 1;
            this.state = 0;
            this.emitNumber();
            continue;
          case 23:
            if (n >= 48 && n <= 57) {
              this.bufferedNumber.appendChar(n);
              this.state = 24;
              continue;
            }
            break;
          case 24:
            if (n >= 48 && n <= 57) {
              this.bufferedNumber.appendChar(n);
              continue;
            }
            if (n === 101 || n === 69) {
              this.bufferedNumber.appendChar(n);
              this.state = 25;
              continue;
            }
            i -= 1;
            this.state = 0;
            this.emitNumber();
            continue;
          // @ts-expect-error fall through case
          case 25:
            if (n === 43 || n === 45) {
              this.bufferedNumber.appendChar(n);
              this.state = 26;
              continue;
            }
          case 26:
            if (n >= 48 && n <= 57) {
              this.bufferedNumber.appendChar(n);
              this.state = 27;
              continue;
            }
            break;
          case 27:
            if (n >= 48 && n <= 57) {
              this.bufferedNumber.appendChar(n);
              continue;
            }
            i -= 1;
            this.state = 0;
            this.emitNumber();
            continue;
          // TRUE
          case 3:
            if (n === 114) {
              this.state = 4;
              continue;
            }
            break;
          case 4:
            if (n === 117) {
              this.state = 5;
              continue;
            }
            break;
          case 5:
            if (n === 101) {
              this.state = 0;
              this.onToken({
                token: tokenType_default.TRUE,
                value: true,
                offset: this.offset
              });
              this.offset += 3;
              continue;
            }
            break;
          // FALSE
          case 6:
            if (n === 97) {
              this.state = 7;
              continue;
            }
            break;
          case 7:
            if (n === 108) {
              this.state = 8;
              continue;
            }
            break;
          case 8:
            if (n === 115) {
              this.state = 9;
              continue;
            }
            break;
          case 9:
            if (n === 101) {
              this.state = 0;
              this.onToken({
                token: tokenType_default.FALSE,
                value: false,
                offset: this.offset
              });
              this.offset += 4;
              continue;
            }
            break;
          // NULL
          case 10:
            if (n === 117) {
              this.state = 11;
              continue;
            }
            break;
          case 11:
            if (n === 108) {
              this.state = 12;
              continue;
            }
            break;
          case 12:
            if (n === 108) {
              this.state = 0;
              this.onToken({
                token: tokenType_default.NULL,
                value: null,
                offset: this.offset
              });
              this.offset += 3;
              continue;
            }
            break;
          case 28:
            this.separatorIndex += 1;
            if (!this.separatorBytes || n !== this.separatorBytes[this.separatorIndex]) {
              break;
            }
            if (this.separatorIndex === this.separatorBytes.length - 1) {
              this.state = 0;
              this.onToken({
                token: tokenType_default.SEPARATOR,
                value: this.separator,
                offset: this.offset + this.separatorIndex
              });
              this.separatorIndex = 0;
            }
            continue;
          // BOM support
          case 30:
            if (n === this.bom[this.bomIndex]) {
              if (this.bomIndex === this.bom.length - 1) {
                this.state = 0;
                this.bom = void 0;
                this.bomIndex = 0;
                continue;
              }
              this.bomIndex += 1;
              continue;
            }
            break;
          case 1:
            if (n === 32 || n === 10 || n === 13 || n === 9) {
              continue;
            }
        }
        throw new TokenizerError(`Unexpected "${String.fromCharCode(n)}" at chunk position "${i}" (absolute position "${this.streamByteLength + i}") in state ${TokenizerStateToString(this.state)}`);
      }
      this.streamByteLength += buffer.length;
      if (this.emitPartialTokens) {
        switch (this.state) {
          case 3:
          case 4:
          case 5:
            this.onToken({
              token: tokenType_default.TRUE,
              value: true,
              offset: this.offset,
              partial: true
            });
            break;
          case 6:
          case 7:
          case 8:
          case 9:
            this.onToken({
              token: tokenType_default.FALSE,
              value: false,
              offset: this.offset,
              partial: true
            });
            break;
          case 10:
          case 11:
          case 12:
            this.onToken({
              token: tokenType_default.NULL,
              value: null,
              offset: this.offset,
              partial: true
            });
            break;
          case 13: {
            const string = this.bufferedString.toString();
            this.onToken({
              token: tokenType_default.STRING,
              value: string,
              offset: this.offset,
              partial: true
            });
            break;
          }
          case 21:
          case 22:
          case 24:
          case 27:
            try {
              this.onToken({
                token: tokenType_default.NUMBER,
                value: this.parseNumber(this.bufferedNumber.toString()),
                offset: this.offset,
                partial: true
              });
            } catch (_a) {
            }
        }
      }
    } catch (err) {
      this.error(err);
    }
  }
  emitNumber() {
    this.onToken({
      token: tokenType_default.NUMBER,
      value: this.parseNumber(this.bufferedNumber.toString()),
      offset: this.offset
    });
    this.offset += this.bufferedNumber.byteLength - 1;
  }
  /**
   * Turns the characters of a JSON number into a JavaScript value.
   *
   * Equivalent to `Number(numberStr)`. Override it to handle numbers that a
   * JavaScript number can't represent, for example by keeping them as strings.
   *
   * @param numberStr The number, as it appeared in the JSON stream.
   * @returns The parsed number.
   */
  parseNumber(numberStr) {
    return Number(numberStr);
  }
  /**
   * Puts the tokenizer in an error state and reports `err` through
   * {@linkcode Tokenizer.onError}. The tokenizer can't be used afterwards.
   *
   * @param err What went wrong.
   */
  error(err) {
    if (this.state !== 1) {
      this.state = 2;
    }
    this.onError(err);
  }
  /**
   * Signals that the stream is over, flushing any number that was still being
   * tokenized and then ending the tokenizer, which can't be used afterwards.
   *
   * @throws {TokenizerError} If the stream ended in the middle of a token and no
   * {@linkcode Tokenizer.onError} callback has been set.
   */
  end() {
    switch (this.state) {
      case 21:
      case 22:
      case 24:
      case 27:
        this.state = 1;
        this.emitNumber();
        this.onEnd();
        break;
      case 29:
      case 0:
      case 2:
        this.state = 1;
        this.onEnd();
        break;
      default:
        this.error(new TokenizerError(`Tokenizer ended in the middle of a token (state: ${TokenizerStateToString(this.state)}). Either not all the data was received or the data was invalid.`));
    }
  }
  /**
   * Called with every token found in the stream. Override it to consume them;
   * by default it throws.
   *
   * @param parsedToken The token and where it was found.
   */
  // biome-ignore lint/correctness/noUnusedFunctionParameters: override point; the parameter is part of the public signature
  onToken(parsedToken) {
    throw new TokenizerError(`Can't emit tokens before the "onToken" callback has been set up.`);
  }
  /**
   * Called when the data can't be tokenized. Override it to handle errors
   * asynchronously; by default it throws, so the error surfaces out of the
   * {@linkcode Tokenizer.write} or {@linkcode Tokenizer.end} call that caused it.
   *
   * @param err What went wrong.
   */
  onError(err) {
    throw err;
  }
  /** Called once the tokenizer has ended. Override it to react to that; by default it does nothing. */
  onEnd() {
  }
};

// node_modules/@streamparser/json/dist/mjs/tokenparser.js
var TokenParserState;
(function(TokenParserState2) {
  TokenParserState2[TokenParserState2["VALUE"] = 0] = "VALUE";
  TokenParserState2[TokenParserState2["KEY"] = 1] = "KEY";
  TokenParserState2[TokenParserState2["COLON"] = 2] = "COLON";
  TokenParserState2[TokenParserState2["COMMA"] = 3] = "COMMA";
  TokenParserState2[TokenParserState2["ENDED"] = 4] = "ENDED";
  TokenParserState2[TokenParserState2["ERROR"] = 5] = "ERROR";
  TokenParserState2[TokenParserState2["SEPARATOR"] = 6] = "SEPARATOR";
})(TokenParserState || (TokenParserState = {}));
function TokenParserStateToString(state) {
  return ["VALUE", "KEY", "COLON", "COMMA", "ENDED", "ERROR", "SEPARATOR"][state];
}
function setProperty(obj, key, value) {
  if (key === "__proto__") {
    Object.defineProperty(obj, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true
    });
    return;
  }
  obj[key] = value;
}
var defaultOpts2 = {
  paths: void 0,
  keepStack: true,
  separator: void 0,
  emitPartialValues: false
};
var TokenParserError = class _TokenParserError extends Error {
  /**
   * @param message What went wrong.
   */
  constructor(message) {
    super(message);
    Object.setPrototypeOf(this, _TokenParserError.prototype);
  }
};
var TokenParser = class {
  /**
   * @param opts What to emit and how. See {@linkcode TokenParserOptions}.
   * @throws {TokenParserError} If any of the configured `paths` is not a valid selector.
   */
  constructor(opts) {
    this.state = 0;
    this.mode = void 0;
    this.key = void 0;
    this.value = void 0;
    this.stack = [];
    this.memberCount = 0;
    opts = Object.assign(Object.assign({}, defaultOpts2), opts);
    if (opts.paths) {
      const root = { children: /* @__PURE__ */ new Map(), terminal: false };
      let matchEverything = false;
      for (const path of opts.paths) {
        if (path === void 0 || path === "$*") {
          matchEverything = true;
          continue;
        }
        if (!path.startsWith("$"))
          throw new TokenParserError(`Invalid selector "${path}". Should start with "$".`);
        const segments = path.split(".").slice(1);
        if (segments.includes(""))
          throw new TokenParserError(`Invalid selector "${path}". ".." syntax not supported.`);
        let node = root;
        for (const segment of segments) {
          let child = node.children.get(segment);
          if (!child) {
            child = { children: /* @__PURE__ */ new Map(), terminal: false };
            node.children.set(segment, child);
          }
          node = child;
        }
        node.terminal = true;
      }
      if (!matchEverything)
        this.selectorTrie = root;
    }
    this.keepStack = opts.keepStack || false;
    this.separator = opts.separator;
    if (!opts.emitPartialValues) {
      this.emitPartial = () => {
      };
    }
  }
  shouldEmit() {
    if (!this.selectorTrie)
      return true;
    return this.matchesSelector(this.selectorTrie, 0);
  }
  // Depth-first walk of the selector trie down the current value's key path:
  //   [stack[1].key, ..., stack[n-1].key, this.key]   (n = stack.length)
  // A value matches iff some branch reaches a terminal node at the exact depth.
  // Recursion (rather than an explicit frontier) keeps the common single-path
  // walk allocation-free and short-circuits on the first match, like the old
  // rescan did, while collapsing its O(number of selectors) cost to O(depth).
  matchesSelector(node, level) {
    const keyCount = this.stack.length;
    if (level === keyCount)
      return node.terminal;
    const key = level < keyCount - 1 ? this.stack[level + 1].key : this.key;
    const wildcard = node.children.get("*");
    if (wildcard && this.matchesSelector(wildcard, level + 1))
      return true;
    const hasLiteralChild = node.children.size > (wildcard ? 1 : 0);
    if (hasLiteralChild) {
      const segment = key === null || key === void 0 ? void 0 : key.toString();
      if (segment !== void 0) {
        const child = node.children.get(segment);
        if (child && this.matchesSelector(child, level + 1))
          return true;
      }
    }
    return false;
  }
  push() {
    this.stack.push({
      key: this.key,
      value: this.value,
      mode: this.mode,
      emit: this.shouldEmit(),
      memberCount: this.memberCount
    });
  }
  pop() {
    const value = this.value;
    let emit;
    ({
      key: this.key,
      value: this.value,
      mode: this.mode,
      emit,
      memberCount: this.memberCount
    } = this.stack.pop());
    this.state = this.mode !== void 0 ? 3 : 0;
    this.emit(value, emit);
  }
  emit(value, emit) {
    if (!this.keepStack && this.value && this.stack.every((item) => !item.emit)) {
      if (Array.isArray(this.value)) {
        this.value.length -= 1;
      } else {
        delete this.value[this.key];
      }
    }
    if (emit) {
      this.onValue({
        value,
        key: this.key,
        parent: this.value,
        stack: this.stack
      });
    }
    if (this.stack.length === 0) {
      if (this.separator) {
        this.state = 6;
      } else if (this.separator === void 0) {
        this.end();
      }
    }
  }
  emitPartial(value) {
    if (!this.shouldEmit())
      return;
    if (this.state === 1) {
      this.onValue({
        value: void 0,
        key: value,
        parent: this.value,
        stack: this.stack,
        partial: true
      });
      return;
    }
    this.onValue({
      value,
      key: this.key,
      parent: this.value,
      stack: this.stack,
      partial: true
    });
  }
  /** Whether the token parser is ended, and thus no longer accepting tokens. */
  get isEnded() {
    return this.state === 4;
  }
  /**
   * Pushes the next token into the parser.
   *
   * Parsing happens synchronously, so every value that the token completes is
   * emitted through {@linkcode TokenParser.onValue} before this returns.
   *
   * @param parsedTokenInfo The token to process, as emitted by a tokenizer.
   * @throws {TokenParserError} If the token can't appear at this point of the
   * JSON document and no {@linkcode TokenParser.onError} callback has been set.
   */
  write({ token, value, partial }) {
    try {
      if (partial) {
        if (this.state !== 0 && this.state !== 1) {
          throw new TokenParserError(`Unexpected partial ${tokenType_default[token]} (${JSON.stringify(value)}) in state ${TokenParserStateToString(this.state)}`);
        }
        this.emitPartial(value);
        return;
      }
      if (this.state === 0) {
        if (token === tokenType_default.STRING || token === tokenType_default.NUMBER || token === tokenType_default.TRUE || token === tokenType_default.FALSE || token === tokenType_default.NULL) {
          if (this.mode === 0) {
            setProperty(this.value, this.key, value);
            this.state = 3;
            this.memberCount++;
          } else if (this.mode === 1) {
            this.value.push(value);
            this.state = 3;
            this.memberCount++;
          }
          this.emit(value, this.shouldEmit());
          return;
        }
        if (token === tokenType_default.LEFT_BRACE) {
          this.memberCount++;
          this.push();
          if (this.mode === 0) {
            const val = {};
            setProperty(this.value, this.key, val);
            this.value = val;
          } else if (this.mode === 1) {
            const val = {};
            this.value.push(val);
            this.value = val;
          } else {
            this.value = {};
          }
          this.mode = 0;
          this.state = 1;
          this.key = void 0;
          this.memberCount = 0;
          this.emitPartial();
          return;
        }
        if (token === tokenType_default.LEFT_BRACKET) {
          this.memberCount++;
          this.push();
          if (this.mode === 0) {
            const val = [];
            setProperty(this.value, this.key, val);
            this.value = val;
          } else if (this.mode === 1) {
            const val = [];
            this.value.push(val);
            this.value = val;
          } else {
            this.value = [];
          }
          this.mode = 1;
          this.state = 0;
          this.key = 0;
          this.memberCount = 0;
          this.emitPartial();
          return;
        }
        if (this.mode === 1 && token === tokenType_default.RIGHT_BRACKET && this.memberCount === 0) {
          this.pop();
          return;
        }
      }
      if (this.state === 1) {
        if (token === tokenType_default.STRING) {
          this.key = value;
          this.state = 2;
          this.emitPartial();
          return;
        }
        if (token === tokenType_default.RIGHT_BRACE && this.memberCount === 0) {
          this.pop();
          return;
        }
      }
      if (this.state === 2) {
        if (token === tokenType_default.COLON) {
          this.state = 0;
          return;
        }
      }
      if (this.state === 3) {
        if (token === tokenType_default.COMMA) {
          if (this.mode === 1) {
            this.state = 0;
            this.key += 1;
            return;
          }
          if (this.mode === 0) {
            this.state = 1;
            return;
          }
        }
        if (token === tokenType_default.RIGHT_BRACE && this.mode === 0 || token === tokenType_default.RIGHT_BRACKET && this.mode === 1) {
          this.pop();
          return;
        }
      }
      if (this.state === 6) {
        if (token === tokenType_default.SEPARATOR && value === this.separator) {
          this.state = 0;
          return;
        }
      }
      if (token === tokenType_default.SEPARATOR && this.state !== 6 && Array.from(value).map((n) => n.charCodeAt(0)).every(
        (n) => n === 32 || n === 10 || n === 13 || n === 9
        /* charset.TAB */
      )) {
        return;
      }
      throw new TokenParserError(`Unexpected ${tokenType_default[token]} (${JSON.stringify(value)}) in state ${TokenParserStateToString(this.state)}`);
    } catch (err) {
      this.error(err);
    }
  }
  /**
   * Puts the token parser in an error state and reports `err` through
   * {@linkcode TokenParser.onError}. The parser can't be used afterwards.
   *
   * @param err What went wrong.
   */
  error(err) {
    if (this.state !== 4) {
      this.state = 5;
    }
    this.onError(err);
  }
  /**
   * Signals that there are no more tokens, ending the token parser, which can't
   * be used afterwards.
   *
   * @throws {Error} If the JSON document was left half-parsed and no
   * {@linkcode TokenParser.onError} callback has been set.
   */
  end() {
    if (this.state !== 0 && this.state !== 6 || this.stack.length > 0) {
      this.error(new Error(`Parser ended in mid-parsing (state: ${TokenParserStateToString(this.state)}). Either not all the data was received or the data was invalid.`));
    } else {
      this.state = 4;
      this.onEnd();
    }
  }
  /**
   * Called with every value that matches the configured `paths`. Override it to
   * consume them; by default it throws.
   *
   * @param parsedElementInfo The value and where it was found. Its `parent` and
   * `stack` are live references into the parser's in-progress structures, so use
   * `cloneParsedElementInfo` to snapshot them if they need to outlive the call.
   */
  // biome-ignore lint/correctness/noUnusedFunctionParameters: override point; the parameter is part of the public signature
  onValue(parsedElementInfo) {
    throw new TokenParserError(`Can't emit data before the "onValue" callback has been set up.`);
  }
  /**
   * Called when the tokens don't add up to valid JSON. Override it to handle
   * errors asynchronously; by default it throws, so the error surfaces out of the
   * {@linkcode TokenParser.write} or {@linkcode TokenParser.end} call that caused it.
   *
   * @param err What went wrong.
   */
  onError(err) {
    throw err;
  }
  /** Called once the token parser has ended. Override it to react to that; by default it does nothing. */
  onEnd() {
  }
};

// node_modules/@streamparser/json/dist/mjs/jsonparser.js
var JSONParser = class {
  /**
   * @param opts How to tokenize and what to emit. See {@linkcode JSONParserOptions}.
   */
  constructor(opts = {}) {
    this.tokenizer = new Tokenizer(opts);
    this.tokenParser = new TokenParser(opts);
    this.tokenizer.onToken = this.tokenParser.write.bind(this.tokenParser);
    this.tokenizer.onEnd = () => {
      if (!this.tokenParser.isEnded)
        this.tokenParser.end();
    };
    this.tokenParser.onError = this.tokenizer.error.bind(this.tokenizer);
    this.tokenParser.onEnd = () => {
      if (!this.tokenizer.isEnded)
        this.tokenizer.end();
    };
  }
  /** Whether the parser is ended, and thus no longer accepting data. */
  get isEnded() {
    return this.tokenizer.isEnded && this.tokenParser.isEnded;
  }
  /**
   * Pushes the next chunk of the JSON stream into the parser.
   *
   * Parsing happens synchronously, so every value that the chunk completes is
   * emitted through {@linkcode JSONParser.onValue} before this returns.
   *
   * @param input The chunk to parse: a string, a `TypedArray`, or any iterable
   * of utf-8 byte values.
   * @throws {Error} If the data is not valid JSON and no
   * {@linkcode JSONParser.onError} callback has been set.
   */
  write(input) {
    this.tokenizer.write(input);
  }
  /**
   * Signals that the stream is over, ending the parser, which can't be used
   * afterwards.
   *
   * @throws {Error} If the JSON document was left half-parsed and no
   * {@linkcode JSONParser.onError} callback has been set.
   */
  end() {
    this.tokenizer.end();
  }
  /** Sets the callback to be called with every token found in the stream. */
  set onToken(cb) {
    this.tokenizer.onToken = (parsedToken) => {
      cb(parsedToken);
      this.tokenParser.write(parsedToken);
    };
  }
  /** Sets the callback to be called with every value that matches the configured `paths`. */
  set onValue(cb) {
    this.tokenParser.onValue = cb;
  }
  /**
   * Sets the callback to be called when the data can't be parsed. Without one,
   * errors are thrown out of the {@linkcode JSONParser.write} or
   * {@linkcode JSONParser.end} call that caused them.
   */
  set onError(cb) {
    this.tokenizer.onError = cb;
  }
  /** Sets the callback to be called once the parser has ended. */
  set onEnd(cb) {
    this.tokenParser.onEnd = () => {
      if (!this.tokenizer.isEnded)
        this.tokenizer.end();
      cb.call(this.tokenParser);
    };
  }
};

// node_modules/@streamparser/json/dist/mjs/utils/types/stackElement.js
var TokenParserMode;
(function(TokenParserMode2) {
  TokenParserMode2[TokenParserMode2["OBJECT"] = 0] = "OBJECT";
  TokenParserMode2[TokenParserMode2["ARRAY"] = 1] = "ARRAY";
})(TokenParserMode || (TokenParserMode = {}));

// connectors/google_maps/archive-stream.ts
var READ_BUFFER_SIZE = 65536;
var DEFAULT_MAX_SINGLE_ELEMENT_BYTES = 4 * 1024 * 1024;
var FIRST_JSON_VALUE_RE = /[^\u0020\t\r\n\uFEFF]/u;
var ROOT_ARRAY_PATHS = ["$.*"];
var SEMANTIC_SEGMENT_PROJECTION_PATHS = [
  "$.semanticSegments.*.startTime",
  "$.semanticSegments.*.startTimestamp",
  "$.semanticSegments.*.endTime",
  "$.semanticSegments.*.endTimestamp",
  "$.semanticSegments.*.duration.startTimestamp",
  "$.semanticSegments.*.duration.startTime",
  "$.semanticSegments.*.duration.endTimestamp",
  "$.semanticSegments.*.duration.endTime",
  "$.semanticSegments.*.visit.topCandidate.placeLocation",
  "$.semanticSegments.*.visit.topCandidate.location",
  "$.semanticSegments.*.visit.topCandidate.placeId",
  "$.semanticSegments.*.visit.topCandidate.placeID",
  "$.semanticSegments.*.visit.topCandidate.semanticType",
  "$.semanticSegments.*.visit.topCandidate.probability",
  "$.semanticSegments.*.visit.topPlace.placeLocation",
  "$.semanticSegments.*.visit.topPlace.location",
  "$.semanticSegments.*.visit.topPlace.placeId",
  "$.semanticSegments.*.visit.topPlace.placeID",
  "$.semanticSegments.*.visit.topPlace.semanticType",
  "$.semanticSegments.*.visit.topPlace.probability",
  "$.semanticSegments.*.placeLocation",
  "$.semanticSegments.*.location",
  "$.semanticSegments.*.placeId",
  "$.semanticSegments.*.placeID",
  "$.semanticSegments.*.semanticType",
  "$.semanticSegments.*.probability",
  "$.semanticSegments.*.activity.topCandidate.type",
  "$.semanticSegments.*.activity.topCandidate.probability",
  "$.semanticSegments.*.activity.topActivity.type",
  "$.semanticSegments.*.activity.activityType",
  "$.semanticSegments.*.activity.probability",
  "$.semanticSegments.*.timelinePath.*"
];
var WRAPPED_ARRAY_ELEMENT_PATHS = [
  "$.locations.*",
  ...SEMANTIC_SEGMENT_PROJECTION_PATHS,
  "$.timelineObjects.*"
];
var GOOGLE_MAPS_SHAPE_KEYS = [
  "locations",
  "semanticSegments",
  "timelineObjects"
];
var GOOGLE_MAPS_SHAPE_KEY_TO_FORMAT = {
  locations: "legacy_records",
  semanticSegments: "semantic_segments",
  timelineObjects: "timeline_objects"
};
function semanticProjectionPath(stack, key) {
  if (stack.length < 3 || stack[1]?.key !== "semanticSegments" || typeof stack[2]?.key !== "number") {
    return null;
  }
  return [...stack.slice(3).map((entry) => String(entry.key)), String(key)];
}
function setProjectionValue(target, path, value) {
  let cursor = target;
  for (const part of path.slice(0, -1)) {
    const existing = cursor[part];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      cursor[part] = {};
    }
    cursor = cursor[part];
  }
  const leaf = path.at(-1);
  if (leaf) {
    cursor[leaf] = value;
  }
}
function cloneProjection(projection) {
  return structuredClone(projection);
}
var SEMANTIC_SEGMENT_KNOWN_KEYS = /* @__PURE__ */ new Set([
  "startTime",
  "startTimestamp",
  "endTime",
  "endTimestamp",
  "duration",
  "visit",
  "activity",
  "timelinePath"
]);
var SemanticSegmentKeyTracker = class {
  stack = [];
  onUnknownKey;
  nextSegmentIndex = 0;
  constructor(onUnknownKey) {
    this.onUnknownKey = onUnknownKey;
  }
  onToken(token, value) {
    if (token === tokenType_default.STRING) {
      this.handleString(value);
      return;
    }
    if (token === tokenType_default.LEFT_BRACE || token === tokenType_default.LEFT_BRACKET) {
      this.handleOpen(token);
      return;
    }
    if (token === tokenType_default.COMMA) {
      this.handleComma();
      return;
    }
    if (token === tokenType_default.RIGHT_BRACE || token === tokenType_default.RIGHT_BRACKET) {
      this.stack.pop();
    }
  }
  handleString(value) {
    const frame = this.stack.at(-1);
    if (frame?.kind !== "object" || frame.pendingKey !== void 0) {
      return;
    }
    const key = typeof value === "string" ? value : void 0;
    frame.pendingKey = key;
    if (key && this.stack.length === 3 && this.stack[1]?.format === "semantic_segments" && !SEMANTIC_SEGMENT_KNOWN_KEYS.has(key) && frame.segmentIndex !== void 0) {
      this.onUnknownKey(frame.segmentIndex, key);
    }
  }
  handleOpen(token) {
    const parent = this.stack.at(-1);
    const isSegment = token === tokenType_default.LEFT_BRACE && parent?.kind === "array" && parent.format === "semantic_segments" && parent.segmentIndex === void 0;
    let segmentIndex = parent?.segmentIndex;
    if (isSegment) {
      segmentIndex = this.nextSegmentIndex;
      this.nextSegmentIndex += 1;
    }
    this.stack.push({
      kind: token === tokenType_default.LEFT_BRACE ? "object" : "array",
      pendingKey: void 0,
      segmentIndex,
      format: token === tokenType_default.LEFT_BRACKET && (parent?.format === "semantic_segments" || parent?.pendingKey === "semanticSegments") ? "semantic_segments" : void 0
    });
  }
  handleComma() {
    const frame = this.stack.at(-1);
    if (frame?.kind === "object") {
      frame.pendingKey = void 0;
    } else if (frame?.kind === "array") {
      frame.segmentIndex = void 0;
    }
  }
};
var GoogleMapsElementTooLargeError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "GoogleMapsElementTooLargeError";
  }
};
var GoogleMapsUnsupportedShapeError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "GoogleMapsUnsupportedShapeError";
  }
};
function formatForShapeKey(key) {
  return GOOGLE_MAPS_SHAPE_KEY_TO_FORMAT[key] ?? null;
}
var RootShapeTracker = class {
  stack = [];
  onArrayConfirmed;
  rootStarted = false;
  invalidRecognizedKey = null;
  constructor(onArrayConfirmed) {
    this.onArrayConfirmed = onArrayConfirmed;
  }
  get invalidKey() {
    return this.invalidRecognizedKey;
  }
  onToken(token, value) {
    if (token === tokenType_default.SEPARATOR) {
      return;
    }
    const frame = this.stack.at(-1);
    if (!frame) {
      this.startRoot(token);
      return;
    }
    if (frame.kind === "object") {
      this.onObjectToken(frame, token, value);
      return;
    }
    this.onArrayToken(frame, token);
  }
  startRoot(token) {
    if (this.rootStarted) {
      return;
    }
    this.rootStarted = true;
    if (token === tokenType_default.LEFT_BRACE) {
      this.stack.push({
        kind: "object",
        pendingKey: void 0,
        state: "key_or_end"
      });
      return;
    }
    if (token === tokenType_default.LEFT_BRACKET) {
      this.stack.push({
        kind: "array",
        state: "value_or_end",
        confirmedFormat: "timeline_objects"
      });
    }
  }
  onObjectToken(frame, token, value) {
    if (frame.state === "key_or_end") {
      if (token === tokenType_default.STRING && typeof value === "string") {
        frame.pendingKey = value;
        frame.state = "colon";
      } else if (token === tokenType_default.RIGHT_BRACE) {
        this.finishContainer();
      }
      return;
    }
    if (frame.state === "colon") {
      if (token === tokenType_default.COLON) {
        frame.state = "value";
      }
      return;
    }
    if (frame.state === "value") {
      this.startObjectValue(frame, token);
      return;
    }
    if (token === tokenType_default.COMMA) {
      frame.state = "key_or_end";
    } else if (token === tokenType_default.RIGHT_BRACE) {
      this.finishContainer();
    }
  }
  startObjectValue(frame, token) {
    const key = frame.pendingKey;
    const format = this.stack.length === 1 && key ? formatForShapeKey(key) : null;
    frame.pendingKey = void 0;
    frame.state = "comma_or_end";
    if (format && token !== tokenType_default.LEFT_BRACKET) {
      this.invalidRecognizedKey ??= key ?? "(unknown)";
    }
    if (token === tokenType_default.LEFT_BRACE) {
      this.stack.push({
        kind: "object",
        pendingKey: void 0,
        state: "key_or_end"
      });
      return;
    }
    if (token === tokenType_default.LEFT_BRACKET) {
      this.stack.push({
        kind: "array",
        state: "value_or_end",
        confirmedFormat: format ?? void 0
      });
    }
  }
  onArrayToken(frame, token) {
    if (frame.state === "value_or_end") {
      if (token === tokenType_default.RIGHT_BRACKET) {
        this.finishContainer();
        return;
      }
      frame.state = "comma_or_end";
      if (token === tokenType_default.LEFT_BRACE) {
        this.stack.push({
          kind: "object",
          pendingKey: void 0,
          state: "key_or_end"
        });
      } else if (token === tokenType_default.LEFT_BRACKET) {
        this.stack.push({
          kind: "array",
          state: "value_or_end",
          confirmedFormat: void 0
        });
      }
      return;
    }
    if (token === tokenType_default.COMMA) {
      frame.state = "value_or_end";
    } else if (token === tokenType_default.RIGHT_BRACKET) {
      this.finishContainer();
    }
  }
  finishContainer() {
    const frame = this.stack.pop();
    if (frame?.kind === "array" && frame.confirmedFormat) {
      this.onArrayConfirmed(frame.confirmedFormat);
    }
  }
};
var ElementByteTracker = class {
  stack = [];
  mode = "normal";
  primitiveIsDirectArrayElement = false;
  stringIsKey = false;
  stringRaw = "";
  maxElementBytes;
  constructor(maxElementBytes) {
    this.maxElementBytes = maxElementBytes;
  }
  consume(text) {
    for (const char of text) {
      this.consumeChar(
        char,
        char.charCodeAt(0) < 128 ? 1 : Buffer.byteLength(char, "utf8")
      );
    }
  }
  consumeChar(char, bytes) {
    if (this.mode === "string" || this.mode === "string_escape") {
      this.consumeStringChar(char, bytes);
      return;
    }
    if (this.mode === "primitive") {
      this.consumePrimitiveChar(char, bytes);
      return;
    }
    this.consumeNormalChar(char, bytes);
  }
  consumeStringChar(char, bytes) {
    this.count(bytes);
    if (this.mode === "string_escape") {
      if (this.stringIsKey) {
        this.stringRaw += char;
      }
      this.mode = "string";
    } else if (char === "\\") {
      if (this.stringIsKey) {
        this.stringRaw += char;
      }
      this.mode = "string_escape";
    } else if (char === '"') {
      this.finishString();
    } else if (this.stringIsKey) {
      this.stringRaw += char;
    }
  }
  consumePrimitiveChar(char, bytes) {
    if (isJsonDelimiter(char)) {
      this.finishPrimitive();
      this.consumeChar(char, bytes);
      return;
    }
    this.count(bytes);
  }
  consumeNormalChar(char, bytes) {
    if (char === '"') {
      const frame = this.stack.at(-1);
      this.stringIsKey = frame?.kind === "object" && frame.root && frame.state === "key_or_end";
      if (!this.stringIsKey) {
        this.beginScalar();
      }
      this.count(bytes);
      this.stringRaw = "";
      this.mode = "string";
      return;
    }
    if (char === "{" || char === "[") {
      this.beginContainer(char === "{" ? "object" : "array");
      this.count(bytes);
      return;
    }
    if (char === "}" || char === "]") {
      this.count(bytes);
      this.finishContainer(char);
      return;
    }
    if (char === ":" || char === ",") {
      this.count(bytes);
      this.transition(char);
      return;
    }
    if (isJsonWhitespace(char)) {
      this.count(bytes);
      return;
    }
    this.beginScalar();
    this.count(bytes);
    this.mode = "primitive";
  }
  beginContainer(kind) {
    const parent = this.stack.at(-1);
    if (!parent) {
      this.stack.push(
        kind === "object" ? { kind, pendingKey: void 0, root: true, state: "key_or_end" } : {
          activeElement: false,
          elementBytes: 0,
          excludeFromParentElementBytes: false,
          format: "timeline_objects",
          kind,
          state: "value_or_end"
        }
      );
      return;
    }
    if (parent.kind === "object") {
      if (parent.state !== "value") {
        return;
      }
      const format = parent.root ? formatForShapeKey(parent.pendingKey ?? "") ?? void 0 : void 0;
      const isTimelinePath = parent.pendingKey === "timelinePath";
      parent.pendingKey = void 0;
      parent.state = "comma_or_end";
      this.stack.push(
        kind === "object" ? { kind, pendingKey: void 0, root: false, state: "key_or_end" } : {
          activeElement: false,
          elementBytes: 0,
          excludeFromParentElementBytes: isTimelinePath,
          format,
          kind,
          state: "value_or_end"
        }
      );
      return;
    }
    if (parent.state !== "value_or_end") {
      return;
    }
    parent.activeElement = true;
    parent.state = "comma_or_end";
    this.stack.push(
      kind === "object" ? { kind, pendingKey: void 0, root: false, state: "key_or_end" } : {
        activeElement: false,
        elementBytes: 0,
        excludeFromParentElementBytes: false,
        format: void 0,
        kind,
        state: "value_or_end"
      }
    );
  }
  beginScalar() {
    const frame = this.stack.at(-1);
    if (!frame) {
      return;
    }
    if (frame.kind === "object") {
      if (frame.state === "value") {
        frame.pendingKey = void 0;
        frame.state = "comma_or_end";
      }
      return;
    }
    if (frame.state === "value_or_end") {
      frame.activeElement = true;
      frame.elementBytes = 0;
      frame.state = "primitive";
      this.primitiveIsDirectArrayElement = true;
    }
  }
  finishString() {
    if (this.stringIsKey) {
      const frame = this.stack.at(-1);
      if (frame?.kind === "object" && frame.state === "key_or_end") {
        frame.pendingKey = decodeJsonString(this.stringRaw);
        frame.state = "colon";
      }
    } else {
      this.finishPrimitive();
    }
    this.mode = "normal";
    this.stringIsKey = false;
    this.stringRaw = "";
  }
  finishPrimitive() {
    if (this.primitiveIsDirectArrayElement) {
      const frame = this.stack.at(-1);
      if (frame?.kind === "array" && frame.state === "primitive") {
        frame.activeElement = false;
        frame.state = "comma_or_end";
        frame.elementBytes = 0;
      }
    }
    this.primitiveIsDirectArrayElement = false;
    this.mode = "normal";
  }
  finishContainer(char) {
    const frame = this.stack.at(-1);
    if (!frame || char === "}" && frame.kind !== "object" || char === "]" && frame.kind !== "array") {
      return;
    }
    this.stack.pop();
    const parent = this.stack.at(-1);
    if (parent?.kind === "array" && parent.activeElement && parent.state === "comma_or_end") {
      parent.activeElement = false;
      parent.elementBytes = 0;
    }
  }
  transition(char) {
    const frame = this.stack.at(-1);
    if (!frame) {
      return;
    }
    if (frame.kind === "object") {
      if (char === ":" && frame.state === "colon") {
        frame.state = "value";
      } else if (char === "," && frame.state === "comma_or_end") {
        frame.state = "key_or_end";
      }
      return;
    }
    if (char === "," && frame.state === "comma_or_end") {
      frame.state = "value_or_end";
      frame.activeElement = false;
    }
  }
  count(bytes) {
    const pathFrame = this.stack.find(
      (candidate) => candidate.kind === "array" && candidate.excludeFromParentElementBytes && candidate.activeElement
    );
    if (pathFrame) {
      pathFrame.elementBytes += bytes;
      if (pathFrame.elementBytes > this.maxElementBytes) {
        throw new GoogleMapsElementTooLargeError(
          `a single Timeline path point exceeded ${String(this.maxElementBytes)} bytes`
        );
      }
      return;
    }
    const frame = this.stack.find(
      (candidate) => candidate.kind === "array" && candidate.format !== void 0 && candidate.activeElement
    );
    if (!frame) {
      return;
    }
    if (frame.format === "semantic_segments" && this.stack.some(
      (candidate) => candidate.kind === "array" && candidate.excludeFromParentElementBytes
    )) {
      return;
    }
    frame.elementBytes += bytes;
    if (frame.elementBytes > this.maxElementBytes) {
      throw new GoogleMapsElementTooLargeError(
        `a single Timeline array element exceeded ${String(this.maxElementBytes)} bytes`
      );
    }
  }
};
function isJsonWhitespace(char) {
  return char === " " || char === "	" || char === "\r" || char === "\n";
}
function isJsonDelimiter(char) {
  return isJsonWhitespace(char) || char === "," || char === "]" || char === "}";
}
function decodeJsonString(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}
function formatForElementEvent(key, stack, parent) {
  if (!Array.isArray(parent)) {
    return null;
  }
  if (stack.length === 1) {
    return typeof key === "number" ? "timeline_objects" : null;
  }
  if (stack.length === 2) {
    const parentKey = stack[1]?.key;
    return typeof parentKey === "string" ? formatForShapeKey(parentKey) : null;
  }
  return null;
}
async function drain(pending, onEvent) {
  const batch = pending.splice(0);
  for (const event of batch) {
    const result = onEvent(event);
    if (result !== void 0) {
      await result;
    }
  }
}
function createParser(paths, shapeTracker, onElement, onEnd, semanticRun) {
  const parser = new JSONParser({
    emitPartialValues: true,
    keepStack: false,
    paths: [...paths]
  });
  const unknownKeys = /* @__PURE__ */ new Map();
  const keyTracker = new SemanticSegmentKeyTracker((index, key) => {
    const keys = unknownKeys.get(index) ?? /* @__PURE__ */ new Set();
    keys.add(key);
    unknownKeys.set(index, keys);
  });
  parser.onToken = ({ token, value }) => {
    shapeTracker.onToken(token, value);
    keyTracker.onToken(token, value);
  };
  let semanticIndex = null;
  let semanticProjection = null;
  let semanticHasPath = false;
  const flushSemanticProjection = () => {
    if (semanticProjection) {
      const index = semanticIndex;
      if (index !== null) {
        for (const key of unknownKeys.get(index) ?? []) {
          semanticProjection[key] ??= {};
        }
        if (semanticRun) {
          semanticRun.onComplete(
            index,
            cloneProjection(semanticProjection),
            semanticHasPath
          );
        } else if (!semanticHasPath) {
          onElement("semantic_segments", cloneProjection(semanticProjection));
        }
      }
    }
    if (semanticIndex !== null) {
      unknownKeys.delete(semanticIndex);
    }
    semanticProjection = null;
    semanticIndex = null;
    semanticHasPath = false;
  };
  const handleSemanticValue = (info) => {
    const semanticPath = semanticProjectionPath(info.stack, info.key);
    if (!semanticPath) {
      return false;
    }
    const nextIndex = info.stack[2]?.key;
    if (typeof nextIndex !== "number") {
      return true;
    }
    if (semanticIndex !== null && semanticIndex !== nextIndex) {
      flushSemanticProjection();
    }
    semanticIndex = nextIndex;
    semanticProjection ??= { timelinePath: void 0 };
    if (semanticPath.at(-2) === "timelinePath") {
      semanticHasPath = true;
      semanticProjection.timelinePath = [info.value];
      for (const key of unknownKeys.get(nextIndex) ?? []) {
        semanticProjection[key] ??= {};
      }
      semanticRun?.onPoint?.(nextIndex, info.value);
      if (!semanticRun) {
        onElement("semantic_segments", cloneProjection(semanticProjection));
      }
      semanticProjection.timelinePath = void 0;
    } else {
      setProjectionValue(semanticProjection, semanticPath, info.value);
    }
    return true;
  };
  parser.onValue = (info) => {
    if (info.partial) {
      return;
    }
    if (handleSemanticValue(info)) {
      return;
    }
    const format = formatForElementEvent(info.key, info.stack, info.parent);
    if (!format || info.value === void 0) {
      return;
    }
    onElement(format, info.value);
  };
  parser.onEnd = () => {
    flushSemanticProjection();
    onEnd();
  };
  return parser;
}
function initializeParser(text, shapeTracker, onElement, onEnd, semanticRun, pathsOverride) {
  const firstIndex = text.search(FIRST_JSON_VALUE_RE);
  if (firstIndex === -1) {
    return null;
  }
  const paths = pathsOverride ?? (text[firstIndex] === "[" ? ROOT_ARRAY_PATHS : WRAPPED_ARRAY_ELEMENT_PATHS);
  return {
    parser: createParser(paths, shapeTracker, onElement, onEnd, semanticRun),
    text: text.slice(firstIndex)
  };
}
async function feedParserChunk(parser, text, elementByteTracker, pending, onEvent) {
  if (parser.isEnded) {
    parser.write(text);
    return;
  }
  elementByteTracker.consume(text);
  parser.write(text);
  await drain(pending, onEvent);
}
async function replaySemanticPath(path, maxSingleElementBytes, semanticProjections, onEvent) {
  const pending = [];
  const onElement = (format, value) => {
    pending.push({ format, kind: "element", value });
  };
  const semanticRun = {
    onComplete(index) {
      semanticProjections.delete(index);
    },
    onPoint(index, point) {
      const projection = semanticProjections.get(index);
      if (!projection) {
        return;
      }
      onElement("semantic_segments", {
        ...cloneProjection(projection),
        timelinePath: [point]
      });
    }
  };
  const shapeTracker = new RootShapeTracker(() => void 0);
  const elementByteTracker = new ElementByteTracker(maxSingleElementBytes);
  let parser = null;
  const stream = createReadStream2(path, {
    encoding: "utf8",
    highWaterMark: READ_BUFFER_SIZE
  });
  try {
    for await (const chunk of stream) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let toFeed = text;
      if (!parser) {
        const initialized = initializeParser(
          text,
          shapeTracker,
          onElement,
          () => void 0,
          semanticRun,
          SEMANTIC_SEGMENT_PROJECTION_PATHS
        );
        if (!initialized) {
          continue;
        }
        ({ parser, text: toFeed } = initialized);
      }
      await feedParserChunk(
        parser,
        toFeed,
        elementByteTracker,
        pending,
        onEvent
      );
    }
  } finally {
    stream.destroy();
  }
  if (parser && !parser.isEnded) {
    parser.end();
  }
  await drain(pending, onEvent);
}
async function streamGoogleMapsExport(path, onEvent, options = {}) {
  const maxSingleElementBytes = options.maxSingleElementBytes ?? DEFAULT_MAX_SINGLE_ELEMENT_BYTES;
  const pending = [];
  const seenShapes = /* @__PURE__ */ new Set();
  const semanticProjections = /* @__PURE__ */ new Map();
  const markShape = (format) => {
    if (seenShapes.has(format)) {
      return;
    }
    seenShapes.add(format);
    pending.push({ format, kind: "shape" });
  };
  const shapeTracker = new RootShapeTracker(markShape);
  const elementByteTracker = new ElementByteTracker(maxSingleElementBytes);
  const onElement = (format, value) => {
    pending.push({ format, kind: "element", value });
  };
  const firstSemanticRun = {
    onComplete(index, projection, hasPath) {
      if (hasPath) {
        semanticProjections.set(index, projection);
      } else {
        onElement("semantic_segments", projection);
      }
    }
  };
  let parser = null;
  const stream = createReadStream2(path, {
    encoding: "utf8",
    highWaterMark: READ_BUFFER_SIZE
  });
  try {
    for await (const chunk of stream) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let toFeed = text;
      if (!parser) {
        const initialized = initializeParser(
          text,
          shapeTracker,
          onElement,
          () => void 0,
          firstSemanticRun
        );
        if (!initialized) {
          continue;
        }
        ({ parser, text: toFeed } = initialized);
      }
      await feedParserChunk(
        parser,
        toFeed,
        elementByteTracker,
        pending,
        onEvent
      );
    }
  } finally {
    stream.destroy();
  }
  if (!parser) {
    throw new Error(
      "google_maps: Timeline document is empty or whitespace-only"
    );
  }
  if (!parser.isEnded) {
    parser.end();
    if (!parser.isEnded) {
      throw new Error(
        "google_maps: Timeline document did not close (truncated or malformed)"
      );
    }
  }
  if (seenShapes.has("semantic_segments")) {
    await replaySemanticPath(
      path,
      maxSingleElementBytes,
      semanticProjections,
      onEvent
    );
  }
  if (shapeTracker.invalidKey) {
    throw new GoogleMapsUnsupportedShapeError(
      `google_maps: recognized Timeline key ${shapeTracker.invalidKey} did not contain an array`
    );
  }
  if (seenShapes.size === 0) {
    throw new GoogleMapsUnsupportedShapeError(
      "google_maps: Timeline document did not contain a recognized Timeline array"
    );
  }
  await drain(pending, onEvent);
}

// connectors/google_maps/parsers.ts
import { createHash } from "node:crypto";
var GOOGLE_E7_DIVISOR = 1e7;
var RECORD_ID_HASH_LENGTH = 24;
var GEO_PREFIX_RE = /^geo:/i;
var GEO_PAIR_RE = /(-?\d+(?:\.\d+)?)[^\d-]+(-?\d+(?:\.\d+)?)/;
function hashId(s) {
  return createHash("sha256").update(s).digest("hex").slice(0, RECORD_ID_HASH_LENGTH);
}
function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function asString(value) {
  return typeof value === "string" && value.trim() ? value : null;
}
function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function isValidLatLon(latitude, longitude) {
  return latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}
function scaleE7(value) {
  const n = asNumber(value);
  return n === null ? null : n / GOOGLE_E7_DIVISOR;
}
function parseIso(value) {
  const raw = asString(value);
  if (!raw) {
    return null;
  }
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}
function parseTimestampMs(value) {
  const raw = typeof value === "number" ? String(value) : asString(value);
  if (!raw) {
    return null;
  }
  const ms = Number.parseInt(raw, 10);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}
function parseTimestamp(value) {
  return parseIso(value) ?? parseTimestampMs(value);
}
function parseLatLonString(value) {
  const match = GEO_PAIR_RE.exec(value.replace(GEO_PREFIX_RE, ""));
  if (!match) {
    return null;
  }
  const latitude = Number.parseFloat(match[1] ?? "");
  const longitude = Number.parseFloat(match[2] ?? "");
  if (!(Number.isFinite(latitude) && Number.isFinite(longitude) && isValidLatLon(latitude, longitude))) {
    return null;
  }
  return { latitude, longitude };
}
function parseLatLon(value) {
  if (typeof value === "string") {
    return parseLatLonString(value);
  }
  const obj = asObject(value);
  if (!obj) {
    return null;
  }
  const latLng = asString(obj.latLng) ?? asString(obj.point);
  if (latLng) {
    return parseLatLonString(latLng);
  }
  const latitude = asNumber(obj.latitude) ?? asNumber(obj.lat) ?? scaleE7(obj.latitudeE7) ?? scaleE7(obj.latE7) ?? scaleE7(obj.sourceE7Lat);
  const longitude = asNumber(obj.longitude) ?? asNumber(obj.lng) ?? asNumber(obj.lon) ?? scaleE7(obj.longitudeE7) ?? scaleE7(obj.lngE7) ?? scaleE7(obj.sourceE7Lng);
  if (latitude === null || longitude === null || !isValidLatLon(latitude, longitude)) {
    return null;
  }
  return { latitude, longitude };
}
function safeProbability(value) {
  const n = asNumber(value);
  return n === null || n < 0 || n > 1 ? null : n;
}
function firstActivityType(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  const top = asObject(value[0]);
  const nested = Array.isArray(top?.activity) ? asObject(top.activity[0]) : null;
  return asString(nested?.type);
}
function buildPoint(input) {
  return {
    id: hashId(
      [
        "google_maps_point",
        input.sourceFormat,
        input.sourceKind,
        input.segmentId ?? "",
        input.timestamp,
        input.latitude.toFixed(7),
        input.longitude.toFixed(7)
      ].join("|")
    ),
    timestamp: input.timestamp,
    latitude: input.latitude,
    longitude: input.longitude,
    accuracy_meters: input.accuracyMeters ?? null,
    altitude_m: input.altitudeM ?? null,
    velocity_mps: input.velocityMps ?? null,
    activity_type: input.activityType ?? null,
    segment_id: input.segmentId ?? null,
    source_format: input.sourceFormat,
    source_kind: input.sourceKind
  };
}
function buildSegment(input) {
  return {
    id: hashId(
      [
        "google_maps_segment",
        input.sourceFormat,
        input.segmentKind,
        input.startTime,
        input.endTime ?? "",
        input.placeId ?? "",
        input.activityType ?? "",
        input.latitude?.toFixed(7) ?? "",
        input.longitude?.toFixed(7) ?? "",
        // Only extend the hash input when this is actually an unrecognized
        // segment, so ids for the three understood kinds stay byte-identical
        // to those already collected (re-import must dedupe, not duplicate).
        ...input.unrecognizedKind ? [input.unrecognizedKind] : []
      ].join("|")
    ),
    start_time: input.startTime,
    end_time: input.endTime ?? null,
    segment_kind: input.segmentKind,
    source_format: input.sourceFormat,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    place_id: input.placeId ?? null,
    semantic_type: input.semanticType ?? null,
    activity_type: input.activityType ?? null,
    probability: input.probability ?? null,
    unrecognized_kind: input.unrecognizedKind ?? null
  };
}
function parseLegacyRecords(json) {
  const locations = Array.isArray(json.locations) ? json.locations : [];
  const points = [];
  for (const loc of locations) {
    const timestamp = parseTimestamp(loc.timestamp) ?? parseTimestampMs(loc.timestampMs);
    const latitude = scaleE7(loc.latitudeE7);
    const longitude = scaleE7(loc.longitudeE7);
    if (!timestamp || latitude === null || longitude === null || !isValidLatLon(latitude, longitude)) {
      continue;
    }
    points.push(
      buildPoint({
        timestamp,
        latitude,
        longitude,
        accuracyMeters: loc.accuracy ?? null,
        altitudeM: loc.altitude ?? null,
        velocityMps: loc.velocity ?? null,
        activityType: firstActivityType(loc.activity),
        sourceFormat: "legacy_records",
        sourceKind: "raw_location"
      })
    );
  }
  return { points, segments: [] };
}
var TIMING_SEGMENT_KEYS = /* @__PURE__ */ new Set([
  "startTime",
  "startTimestamp",
  "endTime",
  "endTimestamp",
  "duration",
  "startTimeTimezoneUtcOffsetMinutes",
  "endTimeTimezoneUtcOffsetMinutes"
]);
function segmentTimes(segment) {
  const duration = asObject(segment.duration);
  return {
    startTime: parseTimestamp(segment.startTime) ?? parseTimestamp(segment.startTimestamp) ?? parseTimestamp(duration?.startTimestamp) ?? parseTimestamp(duration?.startTime),
    endTime: parseTimestamp(segment.endTime) ?? parseTimestamp(segment.endTimestamp) ?? parseTimestamp(duration?.endTimestamp) ?? parseTimestamp(duration?.endTime)
  };
}
function parseTimelinePathPoint(value, segmentId, fallbackTime, sourceFormat) {
  const obj = asObject(value);
  const timestamp = parseTimestamp(obj?.time) ?? parseTimestamp(obj?.timestamp) ?? fallbackTime;
  const latLon = parseLatLon(obj?.point ?? obj?.location ?? value);
  if (!(timestamp && latLon)) {
    return null;
  }
  return buildPoint({
    timestamp,
    latitude: latLon.latitude,
    longitude: latLon.longitude,
    segmentId,
    sourceFormat,
    sourceKind: "timeline_path"
  });
}
var MODELLED_SEGMENT_KEYS = ["visit", "activity", "timelinePath"];
function semanticSegmentKind(visit, activity, hasTimelinePath) {
  if (visit) {
    return "visit";
  }
  if (activity) {
    return "activity";
  }
  return hasTimelinePath ? "path" : "unrecognized";
}
function unrecognizedSegmentKey(segment) {
  const keys = Object.keys(segment).filter(
    (k) => !(MODELLED_SEGMENT_KEYS.includes(k) || TIMING_SEGMENT_KEYS.has(k))
  );
  return keys.length > 0 ? keys.sort().join(",") : "(no payload key)";
}
function parseSemanticSegment(segment) {
  const { startTime, endTime } = segmentTimes(segment);
  const visit = asObject(segment.visit);
  const activity = asObject(segment.activity);
  const timelinePath = Array.isArray(segment.timelinePath) ? segment.timelinePath : [];
  const topVisit = asObject(visit?.topCandidate) ?? asObject(visit?.topPlace);
  const topActivity = asObject(activity?.topCandidate) ?? asObject(activity?.topActivity);
  const visitLocation = parseLatLon(
    topVisit?.placeLocation ?? topVisit?.location ?? visit?.placeLocation ?? visit?.location
  );
  const segmentKind = semanticSegmentKind(
    visit,
    activity,
    timelinePath.length > 0
  );
  const activityType = asString(topActivity?.type) ?? asString(activity?.activityType);
  const placeId = asString(topVisit?.placeID) ?? asString(topVisit?.placeId) ?? asString(visit?.placeId);
  const semanticType = asString(topVisit?.semanticType) ?? asString(visit?.semanticType);
  const probability = safeProbability(
    topVisit?.probability ?? topActivity?.probability ?? visit?.probability ?? activity?.probability
  );
  const segments = [];
  const points = [];
  let segmentId = null;
  if (startTime) {
    const seg = buildSegment({
      startTime,
      endTime,
      segmentKind,
      sourceFormat: "semantic_segments",
      latitude: visitLocation?.latitude ?? null,
      longitude: visitLocation?.longitude ?? null,
      placeId,
      semanticType,
      activityType,
      probability,
      unrecognizedKind: segmentKind === "unrecognized" ? unrecognizedSegmentKey(segment) : null
    });
    segmentId = seg.id;
    segments.push(seg);
  }
  if (visitLocation && startTime) {
    points.push(
      buildPoint({
        timestamp: startTime,
        latitude: visitLocation.latitude,
        longitude: visitLocation.longitude,
        segmentId,
        sourceFormat: "semantic_segments",
        sourceKind: "visit_location"
      })
    );
  }
  for (const point of timelinePath) {
    const parsed = parseTimelinePathPoint(
      point,
      segmentId ?? "",
      startTime,
      "semantic_segments"
    );
    if (parsed) {
      points.push(parsed);
    }
  }
  return { points, segments };
}
function parsePlaceVisitObject(placeVisit) {
  const { startTime, endTime } = segmentTimes(placeVisit);
  const location = asObject(placeVisit.location);
  const latLon = parseLatLon(location);
  if (!startTime) {
    return { points: [], segments: [] };
  }
  const seg = buildSegment({
    startTime,
    endTime,
    segmentKind: "visit",
    sourceFormat: "timeline_objects",
    latitude: latLon?.latitude ?? null,
    longitude: latLon?.longitude ?? null,
    placeId: asString(location?.placeId) ?? asString(location?.placeID),
    semanticType: asString(location?.semanticType)
  });
  const points = [];
  if (latLon) {
    points.push(
      buildPoint({
        timestamp: startTime,
        latitude: latLon.latitude,
        longitude: latLon.longitude,
        segmentId: seg.id,
        sourceFormat: "timeline_objects",
        sourceKind: "visit_location"
      })
    );
  }
  return { points, segments: [seg] };
}
function parseActivitySegmentObject(activitySegment) {
  const { startTime, endTime } = segmentTimes(activitySegment);
  const startLocation = parseLatLon(activitySegment.startLocation);
  const endLocation = parseLatLon(activitySegment.endLocation);
  if (!startTime) {
    return { points: [], segments: [] };
  }
  const seg = buildSegment({
    startTime,
    endTime,
    segmentKind: "activity",
    sourceFormat: "timeline_objects",
    latitude: startLocation?.latitude ?? null,
    longitude: startLocation?.longitude ?? null,
    activityType: asString(activitySegment.activityType)
  });
  const points = [];
  if (startLocation) {
    points.push(
      buildPoint({
        timestamp: startTime,
        latitude: startLocation.latitude,
        longitude: startLocation.longitude,
        segmentId: seg.id,
        sourceFormat: "timeline_objects",
        sourceKind: "activity_start",
        activityType: seg.activity_type
      })
    );
  }
  if (endLocation && endTime) {
    points.push(
      buildPoint({
        timestamp: endTime,
        latitude: endLocation.latitude,
        longitude: endLocation.longitude,
        segmentId: seg.id,
        sourceFormat: "timeline_objects",
        sourceKind: "activity_end",
        activityType: seg.activity_type
      })
    );
  }
  return { points, segments: [seg] };
}
function parseTimelineObject(value) {
  const obj = asObject(value);
  if (!obj) {
    return { points: [], segments: [] };
  }
  const results = [];
  const placeVisit = asObject(obj.placeVisit);
  const activitySegment = asObject(obj.activitySegment);
  if (placeVisit) {
    results.push(parsePlaceVisitObject(placeVisit));
  }
  if (activitySegment) {
    results.push(parseActivitySegmentObject(activitySegment));
  }
  return mergeResults(results);
}
function mergeResults(results) {
  const pointMap = /* @__PURE__ */ new Map();
  const segmentMap = /* @__PURE__ */ new Map();
  for (const result of results) {
    for (const point of result.points) {
      pointMap.set(point.id, point);
    }
    for (const segment of result.segments) {
      segmentMap.set(segment.id, segment);
    }
  }
  return {
    points: [...pointMap.values()].sort(
      (a, b) => a.timestamp.localeCompare(b.timestamp)
    ),
    segments: [...segmentMap.values()].sort(
      (a, b) => a.start_time.localeCompare(b.start_time)
    )
  };
}
function parseGoogleMapsExport(json) {
  const obj = asObject(json);
  const results = [];
  if (Array.isArray(obj?.locations)) {
    results.push(parseLegacyRecords(obj));
  }
  const semanticSegments = Array.isArray(obj?.semanticSegments) ? obj.semanticSegments : [];
  for (const segment of semanticSegments) {
    const parsed = asObject(segment);
    if (parsed) {
      results.push(parseSemanticSegment(parsed));
    }
  }
  const timelineObjects = [];
  if (Array.isArray(obj?.timelineObjects)) {
    timelineObjects.push(...obj.timelineObjects);
  } else if (Array.isArray(json)) {
    timelineObjects.push(...json);
  }
  for (const item of timelineObjects) {
    results.push(parseTimelineObject(item));
  }
  return mergeResults(results);
}
function parseGoogleMapsExportElement(format, value) {
  if (format === "legacy_records") {
    return parseGoogleMapsExport({ locations: [value] });
  }
  if (format === "semantic_segments") {
    return parseGoogleMapsExport({ semanticSegments: [value] });
  }
  return parseGoogleMapsExport([value]);
}

// connectors/google_maps/validation.ts
var GoogleMapsMixedShapeError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "GoogleMapsMixedShapeError";
  }
};
var SHAPE_KEYS = GOOGLE_MAPS_SHAPE_KEYS;
var SHAPE_KEY_TO_FORMAT = GOOGLE_MAPS_SHAPE_KEY_TO_FORMAT;
function nonEmptyShapeKeys(obj) {
  return SHAPE_KEYS.filter((key) => {
    const value = obj[key];
    return Array.isArray(value) && value.length > 0;
  });
}
function nonArrayShapeKeys(obj) {
  return SHAPE_KEYS.filter(
    (key) => Object.hasOwn(obj, key) && !Array.isArray(obj[key])
  );
}
function detectFormat(json) {
  if (Array.isArray(json)) {
    return "timeline_objects";
  }
  if (!json || typeof json !== "object") {
    return "unsupported";
  }
  const obj = json;
  if (nonArrayShapeKeys(obj).length > 0) {
    return "unsupported";
  }
  const nonEmpty = nonEmptyShapeKeys(obj);
  if (nonEmpty.length > 1) {
    return "mixed";
  }
  const [onlyNonEmptyKey] = nonEmpty;
  if (onlyNonEmptyKey) {
    return SHAPE_KEY_TO_FORMAT[onlyNonEmptyKey];
  }
  for (const key of SHAPE_KEYS) {
    if (Array.isArray(obj[key])) {
      return SHAPE_KEY_TO_FORMAT[key];
    }
  }
  return "unsupported";
}
function minMax(values) {
  const sorted = values.filter(Boolean).sort();
  return { end: sorted.at(-1) ?? null, start: sorted[0] ?? null };
}
function remediationFor2(status) {
  switch (status) {
    case "duplicate":
      return "This file was already imported for this source. Export a newer Timeline file from your phone.";
    case "empty":
      return "The file is a recognized Timeline export, but it does not contain importable points or segments.";
    case "stale":
      return "This file only covers dates that are already imported. Export a newer Timeline file from your phone.";
    case "too_large":
      return "This file is larger than the upload limit. A Timeline export this large is unusual \u2014 ask your PDPP operator to raise the deployment limit if this is a genuine export.";
    case "unsupported":
      return "Choose the Timeline JSON export from Google Maps on your phone. Google account passwords and Data Portability archives are not Timeline exports.";
    case "valid":
      return null;
    default:
      return null;
  }
}
var OVERSIZED_RECORD_REMEDIATION = "One record in this export is unusually large and can't be processed. Try re-exporting your Timeline data \u2014 if this keeps happening, the export file may be corrupted.";
var MIXED_SHAPE_REMEDIATION = "This file has more than one kind of Timeline data mixed together, which isn't a shape a real Timeline export uses. Export a fresh Timeline file instead of a hand-edited or merged one.";
function unsupportedResult(fileSha256, remediation = remediationFor2("unsupported") ?? "") {
  return {
    date_range: { end: null, start: null },
    detected_format: "unsupported",
    estimated_points: 0,
    estimated_segments: 0,
    file_sha256: fileSha256,
    remediation,
    status: "unsupported"
  };
}
function tooLargeResult(fileSha256, remediation = remediationFor2("too_large") ?? "") {
  return {
    date_range: { end: null, start: null },
    detected_format: "unsupported",
    estimated_points: 0,
    estimated_segments: 0,
    file_sha256: fileSha256,
    remediation,
    status: "too_large"
  };
}
function buildValidationFromCounts(detectedFormat, pointCount, segmentCount, dateRange2, fileSha256, options) {
  let status = "valid";
  const previousHashes = new Set(options.existingFileHashes ?? []);
  if (previousHashes.has(fileSha256)) {
    status = "duplicate";
  } else if (pointCount === 0 && segmentCount === 0) {
    status = "empty";
  } else if (options.importedThrough && dateRange2.end && dateRange2.end <= options.importedThrough) {
    status = "stale";
  }
  return {
    date_range: dateRange2,
    detected_format: detectedFormat,
    estimated_points: pointCount,
    estimated_segments: segmentCount,
    file_sha256: fileSha256,
    remediation: remediationFor2(status),
    status
  };
}
function validateGoogleMapsTimelineArtifact(input, options = {}) {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  const fileSha256 = createHash2("sha256").update(bytes).digest("hex");
  if (options.maxFileBytes !== null && options.maxFileBytes !== void 0 && bytes.byteLength > options.maxFileBytes) {
    return tooLargeResult(fileSha256);
  }
  let json;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    return unsupportedResult(fileSha256);
  }
  const detectedFormat = detectFormat(json);
  if (detectedFormat === "mixed") {
    return unsupportedResult(fileSha256, MIXED_SHAPE_REMEDIATION);
  }
  if (detectedFormat === "unsupported") {
    return unsupportedResult(fileSha256);
  }
  const parsed = parseGoogleMapsExport(json);
  const dateRange2 = minMax([
    ...parsed.points.map((point) => point.timestamp),
    ...parsed.segments.map((segment) => segment.start_time)
  ]);
  return buildValidationFromCounts(
    detectedFormat,
    parsed.points.length,
    parsed.segments.length,
    dateRange2,
    fileSha256,
    options
  );
}
function accumulateElement(counts, format, value) {
  counts.formatsWithElements.add(format);
  if (counts.formatsWithElements.size > 1) {
    throw new GoogleMapsMixedShapeError(
      `more than one Timeline shape has elements: ${[...counts.formatsWithElements].join(", ")}`
    );
  }
  const parsed = parseGoogleMapsExportElement(format, value);
  counts.pointCount += parsed.points.length;
  counts.segmentCount += parsed.segments.length;
  for (const timestamp of [
    ...parsed.points.map((point) => point.timestamp),
    ...parsed.segments.map((segment) => segment.start_time)
  ]) {
    if (counts.minTimestamp === null || timestamp < counts.minTimestamp) {
      counts.minTimestamp = timestamp;
    }
    if (counts.maxTimestamp === null || timestamp > counts.maxTimestamp) {
      counts.maxTimestamp = timestamp;
    }
  }
}
async function streamCounts(path) {
  const counts = {
    formatsWithElements: /* @__PURE__ */ new Set(),
    maxTimestamp: null,
    minTimestamp: null,
    pointCount: 0,
    recognizedFormatsSeen: /* @__PURE__ */ new Set(),
    segmentCount: 0
  };
  await streamGoogleMapsExport(path, (event) => {
    if (event.kind === "shape") {
      counts.recognizedFormatsSeen.add(event.format);
      return;
    }
    accumulateElement(counts, event.format, event.value);
  });
  return counts;
}
function resolveStreamedFormat(counts) {
  if (counts.formatsWithElements.size === 1) {
    const [onlyFormat] = counts.formatsWithElements;
    return onlyFormat ?? null;
  }
  for (const key of SHAPE_KEYS) {
    const format = SHAPE_KEY_TO_FORMAT[key];
    if (counts.recognizedFormatsSeen.has(format)) {
      return format;
    }
  }
  return null;
}
async function validateGoogleMapsTimelineArtifactFromFile(path, fileSize, options) {
  if (options.maxFileBytes !== null && options.maxFileBytes !== void 0 && fileSize > options.maxFileBytes) {
    return tooLargeResult(options.fileSha256);
  }
  let counts;
  try {
    counts = await streamCounts(path);
  } catch (err) {
    if (err instanceof GoogleMapsElementTooLargeError) {
      return tooLargeResult(options.fileSha256, OVERSIZED_RECORD_REMEDIATION);
    }
    if (err instanceof GoogleMapsMixedShapeError) {
      return unsupportedResult(options.fileSha256, MIXED_SHAPE_REMEDIATION);
    }
    if (err instanceof GoogleMapsUnsupportedShapeError) {
      return unsupportedResult(options.fileSha256);
    }
    return unsupportedResult(options.fileSha256);
  }
  const format = resolveStreamedFormat(counts);
  if (!format) {
    return unsupportedResult(options.fileSha256);
  }
  return buildValidationFromCounts(
    format,
    counts.pointCount,
    counts.segmentCount,
    { end: counts.maxTimestamp, start: counts.minTimestamp },
    options.fileSha256,
    options
  );
}

// connectors/netflix_export/validation.ts
import { createHash as createHash4 } from "node:crypto";

// connectors/netflix_export/parsers.ts
import { createHash as createHash3 } from "node:crypto";
import {
  existsSync as existsSync2,
  readdirSync as readdirSync2,
  readSync as readSync2,
  realpathSync,
  statSync as statSync2
} from "node:fs";
var MAX_CSV_BYTES = 50 * 1024 * 1024;
var MAX_ROWS = 1e5;
var ZIP_EXT_RE2 = /\.zip$/i;
var CSV_EXT_RE = /\.csv$/i;
var NETFLIX_ZIP_POLICY = {
  maxEntries: 5e3,
  maxEntryUncompressedBytes: MAX_CSV_BYTES,
  maxTotalUncompressedBytes: MAX_CSV_BYTES * 10
};
var VIEWING_ACTIVITY_ENTRY_RE = /viewingactivity\.csv$/i;
var RECORD_ID_HASH_LENGTH2 = 24;
function hashId2(s) {
  return createHash3("sha256").update(s).digest("hex").slice(0, RECORD_ID_HASH_LENGTH2);
}
function parseCSVLine(line, headers) {
  const fields = splitCSVFields(line);
  return buildRecord(fields, headers);
}
function splitCSVFields(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current.trim());
  return fields;
}
function buildRecord(fields, headers) {
  const record = {};
  for (let i = 0; i < headers.length; i += 1) {
    const header = headers[i];
    if (header) {
      record[header] = fields[i] === "" ? void 0 : fields[i];
    }
  }
  return record;
}
function hasBalancedQuotes(line) {
  let quoteCount = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '"') {
      if (line[i + 1] === '"') {
        i += 1;
      } else {
        quoteCount += 1;
      }
    }
  }
  return quoteCount % 2 === 0;
}
function parseCSVContentForValidation(content) {
  if (Buffer.byteLength(content, "utf8") > MAX_CSV_BYTES) {
    return {
      headers: [],
      rows: [],
      malformedCount: 0,
      error: `CSV file exceeds maximum size (${MAX_CSV_BYTES})`
    };
  }
  return parseCSVContent(content);
}
function parseCSVContent(content) {
  const lines = content.split("\n");
  if (lines.length === 0 || !lines[0]) {
    return { headers: [], rows: [], malformedCount: 0 };
  }
  const headers = parseHeaders(lines[0]);
  const rows = [];
  let malformedCount = 0;
  let currentLine = "";
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) {
      continue;
    }
    currentLine = currentLine === "" ? line : `${currentLine}
${line}`;
    if (hasBalancedQuotes(currentLine)) {
      if (rows.length >= MAX_ROWS) {
        return {
          headers,
          rows,
          malformedCount,
          error: `CSV exceeds maximum rows (${MAX_ROWS})`
        };
      }
      if (isValidRow()) {
        rows.push(parseCSVLine(currentLine, headers));
      } else {
        malformedCount += 1;
      }
      currentLine = "";
    }
  }
  if (currentLine !== "" && !hasBalancedQuotes(currentLine)) {
    malformedCount += 1;
  }
  return { headers, rows, malformedCount };
}
function parseHeaders(line) {
  return line.split(",").map((h) => h.trim().toLowerCase());
}
function isValidRow() {
  return true;
}
var DIRECT_HISTORY_HEADERS = ["title", "date"];
var FULL_EXPORT_HEADERS = [
  "profile name",
  "start time",
  "duration",
  "attributes",
  "title",
  "supplemental video type",
  "device type",
  "bookmark",
  "latest bookmark",
  "country"
];
function detectViewingActivitySchema(headers) {
  const normalized = headers.map((h) => h.trim().toLowerCase());
  const hasAll = (required) => required.every(
    (req) => normalized.some(
      (h) => h === req || h.startsWith(`${req} `) || h.startsWith(`${req}(`)
    )
  );
  const isDirectHistory = hasAll(DIRECT_HISTORY_HEADERS) && normalized.length <= DIRECT_HISTORY_HEADERS.length + 1;
  const isFullExport = hasAll(FULL_EXPORT_HEADERS);
  if (isFullExport) {
    return "full_export";
  }
  if (isDirectHistory) {
    return "direct_history";
  }
  return null;
}
function findHeaderKey(row, prefix) {
  return Object.keys(row).find(
    (k) => k === prefix || k.startsWith(`${prefix} `) || k.startsWith(`${prefix}(`)
  );
}
function rowValue(row, prefix) {
  const key = findHeaderKey(row, prefix);
  return key ? row[key] : void 0;
}
var ISO_DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
var NUMERIC_DATE_RE = /^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})$/;
function isoDayToUtcMidnight(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date.toISOString();
}
function expandTwoDigitYear(yearStr) {
  if (yearStr.length === 4) {
    return Number(yearStr);
  }
  const twoDigit = Number(yearStr);
  return twoDigit < 69 ? 2e3 + twoDigit : 1900 + twoDigit;
}
function splitAmbiguousDateComponents(dateStr) {
  const match = dateStr.match(NUMERIC_DATE_RE);
  if (!match) {
    return null;
  }
  const [, aRaw, bRaw, yearRaw] = match;
  if (!(aRaw && bRaw && yearRaw)) {
    return null;
  }
  return {
    a: Number(aRaw),
    b: Number(bRaw),
    year: expandTwoDigitYear(yearRaw)
  };
}
function unambiguousOrderFor(components) {
  if (components.a > 12 && components.b <= 12) {
    return "DMY";
  }
  if (components.b > 12 && components.a <= 12) {
    return "MDY";
  }
  return null;
}
function inferDirectHistoryDateOrder(dateStrings) {
  for (const raw of dateStrings) {
    if (!raw) {
      continue;
    }
    const trimmed = raw.trim();
    if (ISO_DATE_ONLY_RE.test(trimmed)) {
      continue;
    }
    const components = splitAmbiguousDateComponents(trimmed);
    if (!components) {
      continue;
    }
    const order = unambiguousOrderFor(components);
    if (order) {
      return order;
    }
  }
  return null;
}
function inferDirectHistoryDateOrderFromRows(rows) {
  return inferDirectHistoryDateOrder(rows.map((row) => rowValue(row, "date")));
}
function parseDirectHistoryDate(dateStr, order = null) {
  if (!dateStr) {
    return null;
  }
  const trimmed = dateStr.trim();
  const isoMatch = trimmed.match(ISO_DATE_ONLY_RE);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return isoDayToUtcMidnight(Number(y), Number(m), Number(d));
  }
  const components = splitAmbiguousDateComponents(trimmed);
  if (!components) {
    return null;
  }
  const selfEvidentOrder = unambiguousOrderFor(components);
  const effectiveOrder = selfEvidentOrder ?? order;
  if (!effectiveOrder) {
    return null;
  }
  return effectiveOrder === "DMY" ? isoDayToUtcMidnight(components.year, components.b, components.a) : isoDayToUtcMidnight(components.year, components.a, components.b);
}
var FULL_EXPORT_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/;
function parseFullExportStartTime(tsStr) {
  if (!tsStr) {
    return null;
  }
  const trimmed = tsStr.trim();
  if (!FULL_EXPORT_TIMESTAMP_RE.test(trimmed)) {
    return null;
  }
  const normalized = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const withZ = normalized.length === 10 ? `${normalized}T00:00:00Z` : `${normalized}Z`;
  const parsed = new Date(withZ);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
var DURATION_HMS_RE = /^(\d+):([0-5]\d):([0-5]\d)$/;
function parseFullExportDurationSeconds(durationStr) {
  if (!durationStr) {
    return null;
  }
  const match = DURATION_HMS_RE.exec(durationStr.trim());
  if (!match) {
    return null;
  }
  const [, h, m, s] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}
function buildViewingActivityRecord(row, schema, dateOrder = null) {
  if (schema === "direct_history") {
    return buildDirectHistoryRecord(row, dateOrder);
  }
  return buildFullExportRecord(row);
}
function buildDirectHistoryRecord(row, dateOrder) {
  const title = rowValue(row, "title") ?? null;
  const dateRaw = rowValue(row, "date");
  const watchedAt = parseDirectHistoryDate(dateRaw, dateOrder);
  if (!watchedAt) {
    return null;
  }
  const idInput = [title, watchedAt].map((v) => String(v)).join("|");
  return {
    country: null,
    device_type: null,
    duration_seconds: null,
    id: hashId2(idInput),
    profile_name: null,
    source_schema: "direct_history",
    title,
    watched_at: watchedAt,
    watched_at_precision: "day",
    watched_at_raw: dateRaw ?? ""
  };
}
function buildFullExportRecord(row) {
  const title = rowValue(row, "title") ?? null;
  const startTimeRaw = rowValue(row, "start time");
  const watchedAt = parseFullExportStartTime(startTimeRaw);
  if (!watchedAt) {
    return null;
  }
  const deviceType = rowValue(row, "device type") ?? null;
  const profileName = rowValue(row, "profile name") ?? null;
  const durationSeconds = parseFullExportDurationSeconds(
    rowValue(row, "duration")
  );
  const country = rowValue(row, "country") ?? null;
  const idInput = [title, watchedAt, deviceType, profileName, durationSeconds].map((v) => String(v)).join("|");
  return {
    country,
    device_type: deviceType,
    duration_seconds: durationSeconds,
    id: hashId2(idInput),
    profile_name: profileName,
    source_schema: "full_export",
    title,
    watched_at: watchedAt,
    watched_at_precision: "instant",
    watched_at_raw: startTimeRaw ?? ""
  };
}
var ZIP_POLICY_CODE_TO_EXTRACTION_CODE = {
  entry_too_large: "entry_too_large",
  too_many_entries: "too_many_entries",
  total_too_large: "total_too_large",
  unsafe_entry_name: "unsafe_entry_name"
};
function extractViewingActivityFromEntries(entries) {
  const match = entries.find(
    (entry) => VIEWING_ACTIVITY_ENTRY_RE.test(zipBasename(entry.name))
  );
  if (!match) {
    return {
      ok: false,
      code: "no_viewing_activity_entry",
      message: "No ViewingActivity.csv entry was found in the uploaded zip archive."
    };
  }
  let csvText;
  try {
    csvText = match.data().toString("utf8");
  } catch (err) {
    if (err instanceof ZipPolicyViolationError) {
      return {
        ok: false,
        code: ZIP_POLICY_CODE_TO_EXTRACTION_CODE[err.code],
        message: err.message
      };
    }
    return {
      ok: false,
      code: "unsupported_shape",
      message: "The ViewingActivity.csv entry in the uploaded zip could not be extracted."
    };
  }
  return {
    ok: true,
    csvText,
    format: "viewing_activity_zip",
    sourceEntryName: match.name
  };
}
function extractViewingActivityArtifact(filename, input) {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  if (ZIP_EXT_RE2.test(filename) || hasZipLocalFileSignature(bytes)) {
    let entries;
    try {
      entries = readZipEntries(bytes, NETFLIX_ZIP_POLICY);
    } catch (err) {
      if (err instanceof ZipPolicyViolationError) {
        return {
          ok: false,
          code: ZIP_POLICY_CODE_TO_EXTRACTION_CODE[err.code],
          message: err.message
        };
      }
      return {
        ok: false,
        code: "unsupported_shape",
        message: "The uploaded zip could not be read."
      };
    }
    return extractViewingActivityFromEntries(entries);
  }
  if (CSV_EXT_RE.test(filename)) {
    return {
      ok: true,
      csvText: bytes.toString("utf8"),
      format: "viewing_activity_csv",
      sourceEntryName: filename
    };
  }
  return {
    ok: false,
    code: "unsupported_shape",
    message: "Choose ViewingActivity.csv, or the .zip archive from netflix.com/account/getmyinfo."
  };
}
function extractViewingActivityArtifactFromFile(fd, fileSize, filename) {
  if (ZIP_EXT_RE2.test(filename)) {
    let entries;
    try {
      entries = readZipEntriesFromFile(fd, fileSize, NETFLIX_ZIP_POLICY);
    } catch (err) {
      if (err instanceof ZipPolicyViolationError) {
        return {
          ok: false,
          code: ZIP_POLICY_CODE_TO_EXTRACTION_CODE[err.code],
          message: err.message
        };
      }
      return {
        ok: false,
        code: "unsupported_shape",
        message: "The uploaded zip could not be read."
      };
    }
    return extractViewingActivityFromEntries(entries);
  }
  if (CSV_EXT_RE.test(filename)) {
    if (fileSize > MAX_CSV_BYTES) {
      return {
        ok: false,
        code: "entry_too_large",
        message: `Uploaded CSV file exceeds the safe read policy (${fileSize} > ${MAX_CSV_BYTES} bytes)`
      };
    }
    const buf = Buffer.allocUnsafe(fileSize);
    readSync2(fd, buf, 0, fileSize, 0);
    return {
      ok: true,
      csvText: buf.toString("utf8"),
      format: "viewing_activity_csv",
      sourceEntryName: filename
    };
  }
  return {
    ok: false,
    code: "unsupported_shape",
    message: "Choose ViewingActivity.csv, or the .zip archive from netflix.com/account/getmyinfo."
  };
}

// connectors/netflix_export/validation.ts
function minMax2(values) {
  const sorted = values.filter(Boolean).sort();
  return { end: sorted.at(-1) ?? null, start: sorted[0] ?? null };
}
function remediationFor3(status) {
  switch (status) {
    case "duplicate":
      return "This export was already imported. Request a newer export from netflix.com/account/getmyinfo if you need more recent activity.";
    case "empty":
      return "This looks like a Netflix viewing activity export, but it does not contain importable rows.";
    case "too_large":
      return "This is a real Netflix export, but it (or the ViewingActivity.csv inside it) is larger than PDPP can safely process from a browser upload. Extract the archive yourself and upload just CONTENT_INTERACTION/ViewingActivity.csv instead of the whole archive.";
    case "unsupported":
      return "Choose the CSV from Download all on netflix.com/viewingactivity, ViewingActivity.csv, or the .zip archive from netflix.com/account/getmyinfo. Other files are not supported.";
    case "ambiguous_date_order":
      return "Every date in this file is ambiguous between DD/MM and MM/DD order (no row's day exceeds 12), so PDPP can't tell which order Netflix used for your account's locale. Re-export a file that includes at least one date with a day above 12, or wait until your history includes one.";
    case "valid":
      return null;
    default:
      return null;
  }
}
function buildValidationFromArtifact(artifact, fileSha256, existingFileHashes) {
  const base = {
    date_range: { end: null, start: null },
    detected_format: "unsupported",
    detected_schema: null,
    estimated_records: 0,
    file_sha256: fileSha256
  };
  if (!artifact.ok) {
    const isSizePolicyRejection = artifact.code === "entry_too_large" || artifact.code === "total_too_large" || artifact.code === "too_many_entries";
    const status2 = isSizePolicyRejection ? "too_large" : "unsupported";
    return { ...base, remediation: remediationFor3(status2), status: status2 };
  }
  const { headers, rows } = parseCSVContentForValidation(artifact.csvText);
  const schema = detectViewingActivitySchema(headers);
  if (!schema) {
    return {
      ...base,
      remediation: remediationFor3("unsupported"),
      status: "unsupported"
    };
  }
  const dateOrder = schema === "direct_history" ? inferDirectHistoryDateOrderFromRows(rows) : null;
  const records = rows.map((row) => buildViewingActivityRecord(row, schema, dateOrder)).filter((rec) => rec !== null);
  if (schema === "direct_history" && !dateOrder && records.length === 0 && rows.some((row) => row.date)) {
    return {
      ...base,
      detected_schema: schema,
      remediation: remediationFor3("ambiguous_date_order"),
      status: "ambiguous_date_order"
    };
  }
  const dateRange2 = minMax2(records.map((rec) => rec.watched_at));
  let status = "valid";
  if (new Set(existingFileHashes ?? []).has(fileSha256)) {
    status = "duplicate";
  } else if (records.length === 0) {
    status = "empty";
  }
  return {
    date_range: dateRange2,
    detected_format: artifact.format,
    detected_schema: schema,
    estimated_records: records.length,
    file_sha256: fileSha256,
    remediation: remediationFor3(status),
    status
  };
}
function validateNetflixExportArtifact(input, options = {}) {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  const fileSha256 = createHash4("sha256").update(bytes).digest("hex");
  if (options.maxFileBytes !== null && options.maxFileBytes !== void 0 && bytes.byteLength > options.maxFileBytes) {
    return {
      date_range: { end: null, start: null },
      detected_format: "unsupported",
      detected_schema: null,
      estimated_records: 0,
      file_sha256: fileSha256,
      remediation: remediationFor3("too_large"),
      status: "too_large"
    };
  }
  const artifact = extractViewingActivityArtifact(
    options.fileName ?? "ViewingActivity.csv",
    bytes
  );
  return buildValidationFromArtifact(
    artifact,
    fileSha256,
    options.existingFileHashes
  );
}
function validateNetflixExportArtifactFromFile(fd, fileName, fileSize, options) {
  if (options.maxFileBytes !== null && options.maxFileBytes !== void 0 && fileSize > options.maxFileBytes) {
    return {
      date_range: { end: null, start: null },
      detected_format: "unsupported",
      detected_schema: null,
      estimated_records: 0,
      file_sha256: options.fileSha256,
      remediation: remediationFor3("too_large"),
      status: "too_large"
    };
  }
  const artifact = extractViewingActivityArtifactFromFile(
    fd,
    fileSize,
    options.fileName ?? fileName
  );
  return buildValidationFromArtifact(
    artifact,
    options.fileSha256,
    options.existingFileHashes
  );
}

// connectors/strava/validation.ts
import { createHash as createHash5 } from "node:crypto";

// connectors/strava/artifact-stream.ts
import { createReadStream as createReadStream3, mkdtempSync as mkdtempSync2, readSync as readSync3, rmSync as rmSync2 } from "node:fs";
import { tmpdir as tmpdir2 } from "node:os";
import { join as join2 } from "node:path";
var ACTIVITIES_CSV = "activities.csv";
var ZIP_POLICY = {
  maxEntries: 2e5,
  maxEntryUncompressedBytes: 256 * 1024 * 1024,
  maxTotalUncompressedBytes: 256 * 1024 * 1024
};
function closeStream(stream) {
  if (stream.readableEnded || stream.destroyed) {
    return;
  }
  stream.destroy();
}
async function streamActivitiesCsvFromFile(fd, fileName, fileSize) {
  if (fileSize === 0) {
    return { ok: false, message: "The uploaded file is empty." };
  }
  if (!fileName.toLowerCase().endsWith(".zip")) {
    const head = Buffer.alloc(Math.min(4, fileSize));
    try {
      const bytesRead = readSync3(fd, head, 0, head.length, 0);
      if (hasZipLocalFileSignature(head.subarray(0, bytesRead))) {
        return {
          ok: false,
          message: "That file is a ZIP archive with a .csv name. Upload it with its original .zip name."
        };
      }
    } catch {
      return { ok: false, message: "The uploaded file could not be read." };
    }
    const stream = createReadStream3("", {
      autoClose: false,
      encoding: "utf8",
      fd,
      start: 0
    });
    return {
      ok: true,
      source: {
        close: () => closeStream(stream),
        stream
      }
    };
  }
  const scratchDir = mkdtempSync2(join2(tmpdir2(), "pdpp-strava-csv-"));
  const scratchPath = join2(scratchDir, ACTIVITIES_CSV);
  let extracted = false;
  try {
    const result = await streamZipEntryToFile(
      fd,
      fileSize,
      ACTIVITIES_CSV,
      scratchPath,
      ZIP_POLICY
    );
    if (!result.found) {
      return {
        ok: false,
        message: `The archive does not contain ${ACTIVITIES_CSV}. Upload the ZIP Strava emailed you, or the ${ACTIVITIES_CSV} from inside it.`
      };
    }
    const stream = createReadStream3(scratchPath, { encoding: "utf8" });
    extracted = true;
    return {
      ok: true,
      source: {
        close: () => {
          closeStream(stream);
          rmSync2(scratchDir, { force: true, recursive: true });
        },
        stream
      }
    };
  } catch (error) {
    if (error instanceof ZipPolicyViolationError) {
      return {
        ok: false,
        message: `The archive exceeds the safe read policy: ${error.message}`,
        status: "too_large"
      };
    }
    return {
      ok: false,
      message: `The uploaded file could not be read: ${error instanceof Error ? error.message : String(error)}`
    };
  } finally {
    if (!extracted) {
      rmSync2(scratchDir, { force: true, recursive: true });
    }
  }
}

// connectors/strava/parsers.ts
var REQUIRED_HEADERS = [
  "Activity ID",
  "Activity Date",
  "Activity Type",
  "Distance",
  "Elapsed Time"
];
var REPEATED_HEADERS = [
  "Commute",
  "Distance",
  "Elapsed Time",
  "Max Heart Rate",
  "Relative Effort"
];
var NUMERIC_ID_RE = /^\d{1,30}$/;
var ISO_WITH_ZONE_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
var ISO_NAKED_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?$/;
var US_LONG_RE = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}):(\d{2}) ([AP]M)$/;
var MONTHS = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12
};
function parseCsvRows(text) {
  const parser = new CsvRowParser();
  const rows = parser.push(text);
  const finished = parser.finish();
  rows.push(...finished.rows);
  return finished.error ? { error: finished.error, rows } : { rows };
}
var CsvRowParser = class {
  field = "";
  inQuotes = false;
  pendingQuote = false;
  row = [];
  sawAnyChar = false;
  push(text) {
    const rows = [];
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (!this.sawAnyChar && ch === "\uFEFF") {
        continue;
      }
      this.sawAnyChar = true;
      if (this.pendingQuote) {
        this.pendingQuote = false;
        if (ch === '"') {
          this.field += '"';
          continue;
        }
        this.inQuotes = false;
      }
      if (this.inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') {
            this.field += '"';
            i += 1;
          } else if (i + 1 === text.length) {
            this.pendingQuote = true;
          } else {
            this.inQuotes = false;
          }
        } else {
          this.field += ch;
        }
        continue;
      }
      if (ch === '"') {
        this.inQuotes = true;
      } else if (ch === ",") {
        this.row.push(this.field);
        this.field = "";
      } else if (ch === "\n") {
        this.row.push(this.field);
        rows.push(this.row);
        this.row = [];
        this.field = "";
      } else if (ch !== "\r") {
        this.field += ch;
      }
    }
    return rows;
  }
  finish() {
    if (this.pendingQuote) {
      this.pendingQuote = false;
      this.inQuotes = false;
    }
    if (this.inQuotes) {
      return { error: "CSV ended inside a quoted field", rows: [] };
    }
    const rows = [];
    if (this.field !== "" || this.row.length > 0) {
      this.row.push(this.field);
      rows.push(this.row);
    }
    if (!this.sawAnyChar) {
      return { error: "CSV file is empty", rows };
    }
    return { rows };
  }
};
async function streamCsvRows(chunks, onRow) {
  const parser = new CsvRowParser();
  let rowCount = 0;
  for await (const chunk of chunks) {
    for (const row of parser.push(chunk)) {
      await onRow(row);
      rowCount += 1;
    }
  }
  const finished = parser.finish();
  for (const row of finished.rows) {
    await onRow(row);
    rowCount += 1;
  }
  return finished.error ? { error: finished.error, rowCount } : { rowCount };
}
function indexOccurrences(header) {
  const occurrences = /* @__PURE__ */ new Map();
  for (const [index, rawName] of header.entries()) {
    const name = rawName.trim();
    const seen = occurrences.get(name);
    if (seen) {
      seen.push(index);
    } else {
      occurrences.set(name, [index]);
    }
  }
  return occurrences;
}
function resolveColumns(header) {
  const occurrences = indexOccurrences(header);
  const missing = REQUIRED_HEADERS.filter((name) => !occurrences.has(name));
  if (missing.length > 0) {
    return {
      missing,
      message: `activities.csv is missing expected column(s): ${missing.join(", ")}. Found: ${[...occurrences.keys()].join(", ") || "(no header row)"}`
    };
  }
  const unexpectedRepeats = [...occurrences.entries()].filter(
    ([name, at2]) => at2.length > 1 && !REPEATED_HEADERS.includes(name)
  ).map(([name]) => name);
  if (unexpectedRepeats.length > 0) {
    return {
      missing: [],
      message: `activities.csv repeats column(s) this connector does not know how to disambiguate: ${unexpectedRepeats.join(", ")}. Strava may have changed the export format; refusing to guess which occurrence is canonical.`
    };
  }
  const first = (name) => occurrences.get(name)?.[0] ?? null;
  const last = (name) => occurrences.get(name)?.at(-1) ?? null;
  return {
    occurrences,
    id: first("Activity ID"),
    activityDate: first("Activity Date"),
    activityType: first("Activity Type"),
    // Repeated headers: see REPEATED_HEADERS for which occurrence is
    // canonical and why. These two take the last — metres and seconds.
    distanceM: last("Distance"),
    elapsedTimeS: last("Elapsed Time"),
    elapsedTimeDisplayS: first("Elapsed Time"),
    movingTimeS: first("Moving Time"),
    elevationGainM: first("Elevation Gain"),
    averageHeartRate: first("Average Heart Rate"),
    maxHeartRate: first("Max Heart Rate"),
    calories: first("Calories"),
    gear: first("Activity Gear")
  };
}
function numberOrNull(cell) {
  if (cell === void 0) {
    return null;
  }
  const trimmed = cell.trim();
  if (trimmed === "") {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}
function textOrNull(cell) {
  const trimmed = cell?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}
function parseActivityDate(raw) {
  const value = raw?.trim() ?? "";
  if (value === "") {
    return null;
  }
  const zoned = ISO_WITH_ZONE_RE.exec(value);
  if (zoned) {
    const [, date, time, zone] = zoned;
    return {
      iso: zone === "Z" ? `${date}T${time}Z` : `${date}T${time}${zone}`,
      basis: "utc"
    };
  }
  const naked = ISO_NAKED_RE.exec(value);
  if (naked) {
    const [, date, time] = naked;
    return { iso: `${date}T${time}`, basis: "unknown" };
  }
  const us = US_LONG_RE.exec(value);
  if (us) {
    const [, mon, day, year, hour12, minute, second, meridiem] = us;
    const month = MONTHS[mon];
    if (month === void 0) {
      return null;
    }
    let hour = Number(hour12) % 12;
    if (meridiem === "PM") {
      hour += 12;
    }
    const pad = (n, width = 2) => String(n).padStart(width, "0");
    return {
      iso: `${year}-${pad(month)}-${pad(Number(day))}T${pad(hour)}:${minute}:${second}`,
      basis: "unknown"
    };
  }
  return null;
}
var at = (row, index) => index === null ? void 0 : row[index];
function buildActivityRecord(row, columns, exportedAt) {
  const id = at(row, columns.id)?.trim() ?? "";
  if (!NUMERIC_ID_RE.test(id)) {
    return null;
  }
  const start = parseActivityDate(at(row, columns.activityDate));
  if (!start) {
    return null;
  }
  return {
    id,
    activity_type: textOrNull(at(row, columns.activityType)),
    // The calendar day, carried separately because `start_time` deliberately
    // does not claim to be an instant. Filtering and grouping need a field the
    // server can treat as a date without one being invented for it.
    start_date: start.iso.slice(0, 10),
    start_time: start.iso,
    start_time_basis: start.basis,
    distance_m: numberOrNull(at(row, columns.distanceM)),
    moving_time_s: numberOrNull(at(row, columns.movingTimeS)),
    // The canonical column is empty on a few rows that the display column
    // still carries — all of them, in the export this was verified against,
    // runs whose moving time was present. Falling back recovers them;
    // `numberOrNull` returning null for a non-numeric cell is what keeps a
    // `MM:SS` display rendering from being read as a count of seconds.
    elapsed_time_s: numberOrNull(at(row, columns.elapsedTimeS)) ?? numberOrNull(at(row, columns.elapsedTimeDisplayS)),
    total_elevation_gain_m: numberOrNull(at(row, columns.elevationGainM)),
    average_heartrate: numberOrNull(at(row, columns.averageHeartRate)),
    max_heartrate: numberOrNull(at(row, columns.maxHeartRate)),
    calories_kcal: numberOrNull(at(row, columns.calories)),
    gear: textOrNull(at(row, columns.gear)),
    freshness: "snapshot",
    exported_at: exportedAt
  };
}

// connectors/strava/validation.ts
function remediationFor4(status) {
  switch (status) {
    case "duplicate":
      return "This Strava account export was already imported. Request a newer archive from Strava if you need more recent activities.";
    case "empty":
      return "This looks like a Strava account export, but activities.csv contains no importable activities.";
    case "too_large":
      return "This Strava file is larger than the upload limit. Extract the archive yourself and upload only activities.csv.";
    case "unsupported":
      return "Choose the ZIP Strava emailed you containing activities.csv, or upload activities.csv from that archive. Other files are not supported.";
    case "valid":
      return null;
  }
}
function baseValidation2(fileSha256, status = "unsupported") {
  return {
    date_range: { end: null, start: null },
    detected_format: "unsupported",
    detected_headers: null,
    estimated_records: 0,
    file_sha256: fileSha256,
    remediation: remediationFor4(status),
    repeated_headers: null,
    status
  };
}
function formatForFileName(fileName) {
  if (fileName?.toLowerCase().endsWith(".zip")) {
    return "strava_account_export_zip";
  }
  if (fileName?.toLowerCase().endsWith(".csv")) {
    return "strava_account_export_csv";
  }
  return null;
}
function hasExpectedRepeatedHeaders(columns) {
  return columns.occurrences.get("Distance")?.length === 2 && columns.occurrences.get("Elapsed Time")?.length === 2;
}
function dateRange(values) {
  let start = null;
  let end = null;
  for (const value of values) {
    if (!start || value < start) {
      start = value;
    }
    if (!end || value > end) {
      end = value;
    }
  }
  return { end, start };
}
var ValidationAccumulator = class {
  columns = null;
  earliest = null;
  latest = null;
  recordCount = 0;
  header = null;
  headerError = false;
  accept(row, exportedAt) {
    if (!this.header) {
      this.header = row;
      const resolved = resolveColumns(row);
      if (!("occurrences" in resolved)) {
        this.headerError = true;
        return;
      }
      this.columns = resolved;
      return;
    }
    if (this.headerError || !this.columns) {
      return;
    }
    if (row.length === 1 && row[0]?.trim() === "") {
      return;
    }
    const record = buildActivityRecord(row, this.columns, exportedAt);
    if (!record) {
      return;
    }
    this.recordCount += 1;
    if (!this.earliest || record.start_time < this.earliest) {
      this.earliest = record.start_time;
    }
    if (!this.latest || record.start_time > this.latest) {
      this.latest = record.start_time;
    }
  }
  result(format, fileSha256, existingFileHashes, parseError) {
    const base = baseValidation2(fileSha256);
    if (!this.header || this.headerError || !this.columns || parseError) {
      return {
        ...base,
        detected_headers: this.header
      };
    }
    if (!hasExpectedRepeatedHeaders(this.columns)) {
      return {
        ...base,
        detected_headers: this.header
      };
    }
    const status = new Set(
      existingFileHashes ?? []
    ).has(fileSha256) ? "duplicate" : this.recordCount === 0 ? "empty" : "valid";
    return {
      date_range: dateRange(
        [this.earliest, this.latest].filter(
          (value) => value !== null
        )
      ),
      detected_format: format,
      detected_headers: this.header,
      estimated_records: this.recordCount,
      file_sha256: fileSha256,
      remediation: remediationFor4(status),
      repeated_headers: {
        distance: this.columns.occurrences.get("Distance") ?? [],
        elapsed_time: this.columns.occurrences.get("Elapsed Time") ?? []
      },
      status
    };
  }
};
function validateRows(rows, format, fileSha256, options, parseError) {
  const accumulator = new ValidationAccumulator();
  for (const row of rows) {
    accumulator.accept(row, null);
  }
  return accumulator.result(
    format,
    fileSha256,
    options.existingFileHashes,
    parseError
  );
}
function validateBufferContents(bytes, format, fileSha256, options) {
  if (format === "strava_account_export_csv") {
    const parsed = parseCsvRows(bytes.toString("utf8"));
    return validateRows(parsed.rows, format, fileSha256, options, parsed.error);
  }
  try {
    const entries = readZipEntries(bytes, ZIP_POLICY);
    const match = entries.find(
      (entry) => zipBasename(entry.name).toLowerCase() === ACTIVITIES_CSV
    );
    if (!match) {
      return baseValidation2(fileSha256);
    }
    const parsed = parseCsvRows(match.data().toString("utf8"));
    return validateRows(parsed.rows, format, fileSha256, options, parsed.error);
  } catch (error) {
    return baseValidation2(
      fileSha256,
      error instanceof ZipPolicyViolationError ? "too_large" : "unsupported"
    );
  }
}
function validateStravaAccountExportArtifact(input, options = {}) {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  const fileSha256 = createHash5("sha256").update(bytes).digest("hex");
  const fileName = options.fileName ?? ACTIVITIES_CSV;
  const format = formatForFileName(fileName);
  if (options.maxFileBytes !== null && options.maxFileBytes !== void 0 && bytes.byteLength > options.maxFileBytes) {
    return baseValidation2(fileSha256, "too_large");
  }
  if (!format) {
    return baseValidation2(fileSha256);
  }
  return validateBufferContents(bytes, format, fileSha256, options);
}
async function validateStravaAccountExportArtifactFromFile(fd, _filePath, fileSize, options) {
  if (options.maxFileBytes !== null && options.maxFileBytes !== void 0 && fileSize > options.maxFileBytes) {
    return baseValidation2(options.fileSha256, "too_large");
  }
  const format = formatForFileName(options.fileName);
  if (!format) {
    return baseValidation2(options.fileSha256);
  }
  const opened = await streamActivitiesCsvFromFile(
    fd,
    options.fileName,
    fileSize
  );
  if (!opened.ok) {
    return baseValidation2(options.fileSha256, opened.status ?? "unsupported");
  }
  const accumulator = new ValidationAccumulator();
  try {
    const parsed = await streamCsvRows(opened.source.stream, async (row) => {
      accumulator.accept(row, null);
    });
    return accumulator.result(
      format,
      options.fileSha256,
      options.existingFileHashes,
      parsed.error
    );
  } catch {
    return baseValidation2(options.fileSha256);
  } finally {
    opened.source.close();
  }
}

// connectors/whatsapp/validation.ts
import { createHash as createHash7 } from "node:crypto";
import { createReadStream as createReadStream4, statSync as statSync3 } from "node:fs";
import { createInterface } from "node:readline";

// connectors/whatsapp/parsers.ts
import { createHash as createHash6 } from "node:crypto";
var GIB = 1024 * 1024 * 1024;
function resolveMaxTotalUncompressedBytes() {
  const raw = process.env.WHATSAPP_MAX_ARCHIVE_BYTES;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20 * GIB;
}
function whatsappZipPolicy() {
  return {
    maxEntries: 2e4,
    maxEntryUncompressedBytes: 2 * GIB,
    maxTotalUncompressedBytes: resolveMaxTotalUncompressedBytes()
  };
}
var MAX_CHAT_TEXT_BYTES = 200 * 1024 * 1024;
function resolveMaxMessageCount() {
  const raw = process.env.WHATSAPP_MAX_MESSAGE_COUNT;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2e6;
}
var WhatsAppMessageLimitExceededError = class extends Error {
  constructor(messageCount, maxMessageCount) {
    super(
      `WhatsApp export exceeds the maximum supported message count (${messageCount} > ${maxMessageCount})`
    );
    this.name = "WhatsAppMessageLimitExceededError";
  }
};
var LINE_RE = /^\s*(?:\[)?(\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap][Mm])?)(?:\])?\s*[-–]?\s*([^:]+?):\s?(.*)$/;
var WHATSAPP_ATTACHMENT_RE = /<attached: |<Media omitted>|image omitted|video omitted|audio omitted|document omitted/i;
var TXT_EXT_RE = /\.txt$/i;
var ZIP_EXT_RE3 = /\.zip$/i;
var WHATSAPP_TITLE_PREFIX_RE = /^WhatsApp Chat - /;
var WHATSAPP_LINE_SPLIT_RE = /\r?\n/;
var WHATSAPP_EXPORT_PROBE_RE = /\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}.*(?:-|]).*?:/;
var basename = zipBasename;
var WHATSAPP_TIME_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([APap][Mm]))?$/;
var CHAT_ID_HASH_LENGTH = 16;
var MESSAGE_ID_HASH_LENGTH = 16;
function deriveChatIdentityKey(participants) {
  const key = [...participants].sort().join("");
  return createHash6("sha256").update(key).digest("hex").slice(0, CHAT_ID_HASH_LENGTH);
}
function mintChatId(identityKey, salt) {
  return createHash6("sha256").update(`${identityKey}${salt}`).digest("hex").slice(0, CHAT_ID_HASH_LENGTH);
}
function messageContentFingerprint(message, occurrenceIndex) {
  const key = `${message.author}${message.sent_at}${message.content}${occurrenceIndex}`;
  return createHash6("sha256").update(key).digest("hex").slice(0, MESSAGE_ID_HASH_LENGTH);
}
function parseWhatsAppDateParts(dateStr) {
  let separator = ".";
  if (dateStr.includes("/")) {
    separator = "/";
  } else if (dateStr.includes("-")) {
    separator = "-";
  }
  const parts = dateStr.split(separator);
  if (parts.length !== 3) {
    return null;
  }
  const [firstRaw, secondRaw, thirdRaw] = parts;
  const first = Number(firstRaw);
  const second = Number(secondRaw);
  const third = Number(thirdRaw);
  if (![first, second, third].every(Number.isInteger)) {
    return null;
  }
  let day;
  let month;
  let year;
  if ((firstRaw?.length ?? 0) === 4) {
    year = first;
    month = second;
    day = third;
  } else {
    year = third;
    if (third >= 70 && third < 100) {
      year = 1900 + third;
    } else if (third < 70) {
      year = 2e3 + third;
    }
    if (first > 12 && second <= 12) {
      day = first;
      month = second;
    } else {
      month = first;
      day = second;
    }
  }
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  return { day, month, year };
}
function parseWhatsAppTimeParts(timeStr) {
  const match = WHATSAPP_TIME_RE.exec(timeStr.trim());
  if (!match) {
    return null;
  }
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === void 0 ? 0 : Number(match[3]);
  const meridiem = match[4]?.toLowerCase();
  if (!(Number.isInteger(hour) && Number.isInteger(minute) && Number.isInteger(second))) {
    return null;
  }
  if (meridiem) {
    if (hour < 1 || hour > 12) {
      return null;
    }
    if (meridiem === "pm" && hour !== 12) {
      hour += 12;
    } else if (meridiem === "am" && hour === 12) {
      hour = 0;
    }
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) {
    return null;
  }
  return { hour, minute, second };
}
function parseWhatsAppDateTime(dateStr, timeStr) {
  const dateParts = parseWhatsAppDateParts(dateStr);
  const timeParts = parseWhatsAppTimeParts(timeStr);
  if (!(dateParts && timeParts)) {
    return null;
  }
  const date = new Date(
    dateParts.year,
    dateParts.month - 1,
    dateParts.day,
    timeParts.hour,
    timeParts.minute,
    timeParts.second
  );
  if (date.getFullYear() === dateParts.year && date.getMonth() === dateParts.month - 1 && date.getDate() === dateParts.day && date.getHours() === timeParts.hour && date.getMinutes() === timeParts.minute && date.getSeconds() === timeParts.second) {
    return date.toISOString();
  }
  return null;
}
function splitWhatsAppChatLines(content) {
  return content.split(WHATSAPP_LINE_SPLIT_RE);
}
function whatsappChatTitleFromFilename(filename) {
  return filename.replace(TXT_EXT_RE, "").replace(WHATSAPP_TITLE_PREFIX_RE, "");
}
function looksLikeWhatsAppChatExport(text) {
  return WHATSAPP_EXPORT_PROBE_RE.test(text);
}
function isProbablyMediaEntry(name) {
  const clean = name.replaceAll("\\", "/");
  if (!clean || clean.endsWith("/") || clean.startsWith("__MACOSX/") || clean.includes("/__MACOSX/")) {
    return false;
  }
  return !TXT_EXT_RE.test(clean);
}
var WhatsAppZipPolicyRejection = class extends Error {
  code;
  constructor(cause) {
    super(cause.message, { cause });
    this.name = "WhatsAppZipPolicyRejection";
    this.code = cause.code;
  }
};
function lazyMediaFiles(entries) {
  return entries.filter((e) => isProbablyMediaEntry(e.name)).map((entry) => ({
    data: entry.data,
    filename: basename(entry.name)
  }));
}
function findChatTextEntry(entries, mediaFiles) {
  const textEntries = entries.filter((entry) => TXT_EXT_RE.test(entry.name));
  for (const entry of textEntries) {
    if (entry.uncompressedSize > MAX_CHAT_TEXT_BYTES) {
      continue;
    }
    let text;
    try {
      text = entry.data().toString("utf8");
    } catch {
      continue;
    }
    if (looksLikeWhatsAppChatExport(text)) {
      return {
        chatFileName: basename(entry.name),
        format: "whatsapp_chat_export_zip",
        mediaFileCount: mediaFiles.length,
        mediaFiles,
        // skippedMediaCount is no longer knowable up front now that
        // attachment extraction is lazy — a media entry that will fail
        // policy/corruption checks only reveals that when its OWN data() is
        // called, which the caller (index.ts) does per-attachment during
        // emission. See emitAttachmentRecords' own skip accounting.
        skippedMediaCount: 0,
        text
      };
    }
  }
  return null;
}
function extractEntriesOrNull(readEntries) {
  try {
    return readEntries();
  } catch (err) {
    if (err instanceof ZipPolicyViolationError) {
      throw new WhatsAppZipPolicyRejection(err);
    }
    return null;
  }
}
function extractFromZip(bytes) {
  const entries = extractEntriesOrNull(
    () => readZipEntries(bytes, whatsappZipPolicy())
  );
  return entries ? findChatTextEntry(entries, lazyMediaFiles(entries)) : null;
}
function extractWhatsAppChatArtifactFromFile(fd, fileSize) {
  const entries = extractEntriesOrNull(
    () => readZipEntriesFromFile(fd, fileSize, whatsappZipPolicy())
  );
  return entries ? findChatTextEntry(entries, lazyMediaFiles(entries)) : null;
}
function extractWhatsAppChatArtifact(filename, input) {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  if (ZIP_EXT_RE3.test(filename) || hasZipLocalFileSignature(bytes)) {
    return extractFromZip(bytes);
  }
  const text = bytes.toString("utf8");
  return looksLikeWhatsAppChatExport(text) ? {
    chatFileName: filename,
    format: "whatsapp_chat_export",
    mediaFileCount: 0,
    mediaFiles: [],
    skippedMediaCount: 0,
    text
  } : null;
}
var RawWhatsAppLineReader = class {
  current = null;
  onMessage;
  participants = /* @__PURE__ */ new Set();
  constructor(onMessage) {
    this.onMessage = onMessage;
  }
  pushLine(line) {
    const match = LINE_RE.exec(line);
    const sentAt = match ? parseWhatsAppDateTime(match[1] ?? "", match[2] ?? "") : null;
    if (match && sentAt) {
      if (this.current) {
        this.onMessage(this.current);
      }
      const author = (match[3] ?? "").trim();
      this.participants.add(author);
      this.current = {
        author,
        content: match[4] || "",
        has_attachment: false,
        sent_at: sentAt
      };
    } else if (this.current && line.trim()) {
      this.current.content += `
${line}`;
    }
  }
  finish() {
    if (this.current) {
      this.onMessage(this.current);
      this.current = null;
    }
  }
};
var ReservoirSampler = class {
  seen = 0;
  items = [];
  capacity;
  constructor(capacity) {
    this.capacity = capacity;
  }
  push(item) {
    this.seen += 1;
    if (this.items.length < this.capacity) {
      this.items.push(item);
      return;
    }
    const replaceIndex = Math.floor(Math.random() * this.seen);
    if (replaceIndex < this.capacity) {
      this.items[replaceIndex] = item;
    }
  }
  toArray() {
    return [...this.items];
  }
};
var MESSAGE_FINGERPRINT_SAMPLE_SIZE = 40;
var ChatIdentityAccumulator = class {
  maxMessageCount = resolveMaxMessageCount();
  occurrenceSeen = /* @__PURE__ */ new Map();
  fingerprintSampler = new ReservoirSampler(
    MESSAGE_FINGERPRINT_SAMPLE_SIZE
  );
  messageCount = 0;
  attachmentMessageCount = 0;
  firstSentAt = null;
  lastSentAt = null;
  onMessage = (message) => {
    this.messageCount += 1;
    if (this.messageCount > this.maxMessageCount) {
      throw new WhatsAppMessageLimitExceededError(
        this.messageCount,
        this.maxMessageCount
      );
    }
    if (WHATSAPP_ATTACHMENT_RE.test(message.content)) {
      this.attachmentMessageCount += 1;
    }
    if (this.firstSentAt === null || message.sent_at < this.firstSentAt) {
      this.firstSentAt = message.sent_at;
    }
    if (this.lastSentAt === null || message.sent_at > this.lastSentAt) {
      this.lastSentAt = message.sent_at;
    }
    const dedupeKey = `${message.author}${message.sent_at}${message.content}`;
    const occurrenceIndex = this.occurrenceSeen.get(dedupeKey) ?? 0;
    this.occurrenceSeen.set(dedupeKey, occurrenceIndex + 1);
    this.fingerprintSampler.push(
      messageContentFingerprint(message, occurrenceIndex)
    );
  };
  toSummary(filename, participants) {
    const identityKey = deriveChatIdentityKey(participants);
    return {
      attachmentMessageCount: this.attachmentMessageCount,
      chatId: mintChatId(identityKey, ""),
      firstSentAt: this.firstSentAt,
      identityKey,
      lastSentAt: this.lastSentAt,
      messageCount: this.messageCount,
      messageFingerprintSample: this.fingerprintSampler.toArray(),
      participants: [...participants],
      title: whatsappChatTitleFromFilename(filename)
    };
  }
};
function scanWhatsAppChatIdentity(filename, lines) {
  const accumulator = new ChatIdentityAccumulator();
  const reader = new RawWhatsAppLineReader(accumulator.onMessage);
  for (const line of lines) {
    reader.pushLine(line);
  }
  reader.finish();
  return accumulator.toSummary(filename, [...reader.participants]);
}
async function scanWhatsAppChatIdentityStream(filename, lines) {
  const accumulator = new ChatIdentityAccumulator();
  const reader = new RawWhatsAppLineReader(accumulator.onMessage);
  for await (const line of lines) {
    reader.pushLine(line);
  }
  reader.finish();
  return accumulator.toSummary(filename, [...reader.participants]);
}

// connectors/whatsapp/validation.ts
function remediationFor5(status) {
  switch (status) {
    case "duplicate":
      return "This chat export was already imported. Export the chat again if you need newer messages.";
    case "empty":
      return "The file looks like a WhatsApp chat export, but it does not contain importable messages.";
    case "too_large":
      return "This chat export is larger than the upload limit. Import a smaller chat export first.";
    case "unsupported":
      return "Choose a WhatsApp chat export .txt file or the .zip created by Export chat with media. Account reports, screenshots, and encrypted backups are not chat exports.";
    case "valid":
      return null;
    default:
      return null;
  }
}
function mediaCoverageStatus(attachedMediaFiles, referencedMediaFiles) {
  if (attachedMediaFiles > 0) {
    return "included_for_import";
  }
  if (referencedMediaFiles > 0) {
    return "not_included";
  }
  return "none_referenced";
}
function baseValidation3(fileSha256) {
  return {
    date_range: { end: null, start: null },
    detected_format: "unsupported",
    estimated_attachments: 0,
    estimated_chats: 0,
    estimated_messages: 0,
    estimated_participants: 0,
    estimated_records: 0,
    file_sha256: fileSha256,
    media_coverage: {
      attached_media_files: 0,
      referenced_media_files: 0,
      status: "none_referenced"
    },
    warnings: [],
    source_identity: null
  };
}
function buildValidationFromSummary2(artifactSummary, fileSha256, existingFileHashes) {
  const { format, mediaFileCount, summary } = artifactSummary;
  const dateRange2 = { end: summary.lastSentAt, start: summary.firstSentAt };
  const attachmentCount = summary.attachmentMessageCount;
  let status = "valid";
  if (new Set(existingFileHashes ?? []).has(fileSha256)) {
    status = "duplicate";
  } else if (summary.messageCount === 0) {
    status = "empty";
  }
  const warnings = [];
  if (attachmentCount > 0 && mediaFileCount > 0) {
    warnings.push(
      "This export includes media files. PDPP will import them as WhatsApp attachment records."
    );
  } else if (attachmentCount > 0) {
    warnings.push(
      "This text export references media, but the media files are not included in this import."
    );
  } else if (mediaFileCount > 0) {
    warnings.push(
      "This zip includes media-like files, but the parsed chat text did not reference them. PDPP will still import them as attachment records for this chat."
    );
  }
  return {
    date_range: dateRange2,
    detected_format: format,
    estimated_attachments: attachmentCount,
    estimated_chats: summary.messageCount > 0 ? 1 : 0,
    estimated_messages: summary.messageCount,
    estimated_participants: summary.participants.length,
    estimated_records: summary.messageCount + (summary.messageCount > 0 ? 1 : 0),
    file_sha256: fileSha256,
    media_coverage: {
      attached_media_files: mediaFileCount,
      referenced_media_files: attachmentCount,
      status: mediaCoverageStatus(mediaFileCount, attachmentCount)
    },
    remediation: remediationFor5(status),
    source_identity: summary.messageCount > 0 ? {
      kind: "whatsapp_chat",
      participant_count: summary.participants.length,
      participant_preview: summary.participants.slice(0, 8),
      stable_id: summary.chatId,
      suggested_display_name: summary.title ? `WhatsApp - ${summary.title}` : "WhatsApp chat export",
      title: summary.title
    } : null,
    status,
    warnings
  };
}
function validateWhatsAppChatExportArtifact(input, options = {}) {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  const fileSha256 = createHash7("sha256").update(bytes).digest("hex");
  const base = baseValidation3(fileSha256);
  if (options.maxFileBytes !== null && options.maxFileBytes !== void 0 && bytes.byteLength > options.maxFileBytes) {
    return {
      ...base,
      remediation: remediationFor5("too_large"),
      status: "too_large"
    };
  }
  let artifact;
  try {
    artifact = extractWhatsAppChatArtifact(
      options.fileName ?? "WhatsApp Chat.txt",
      bytes
    );
  } catch (err) {
    if (err instanceof WhatsAppZipPolicyRejection) {
      return {
        ...base,
        remediation: remediationFor5("too_large"),
        status: "too_large"
      };
    }
    throw err;
  }
  if (!artifact) {
    return {
      ...base,
      remediation: remediationFor5("unsupported"),
      status: "unsupported"
    };
  }
  let summary;
  try {
    summary = scanWhatsAppChatIdentity(
      artifact.chatFileName,
      splitWhatsAppChatLines(artifact.text)
    );
  } catch (err) {
    if (err instanceof WhatsAppMessageLimitExceededError) {
      return {
        ...base,
        remediation: remediationFor5("too_large"),
        status: "too_large"
      };
    }
    throw err;
  }
  return buildValidationFromSummary2(
    {
      format: artifact.format,
      mediaFileCount: artifact.mediaFileCount,
      summary
    },
    fileSha256,
    options.existingFileHashes
  );
}
async function validateWhatsAppChatExportArtifactFromFile(fd, fileName, fileSize, options) {
  const base = baseValidation3(options.fileSha256);
  if (options.maxFileBytes !== null && options.maxFileBytes !== void 0 && fileSize > options.maxFileBytes) {
    return {
      ...base,
      remediation: remediationFor5("too_large"),
      status: "too_large"
    };
  }
  const displayFileName = options.fileName ?? fileName;
  const summary = ZIP_EXT_RE3.test(fileName) ? parseZipArtifactSummary(fd, fileSize) : await parseTextArtifactSummary(fileName, displayFileName);
  if (summary === "too_large") {
    return {
      ...base,
      remediation: remediationFor5("too_large"),
      status: "too_large"
    };
  }
  if (!summary) {
    return {
      ...base,
      remediation: remediationFor5("unsupported"),
      status: "unsupported"
    };
  }
  return buildValidationFromSummary2(
    summary,
    options.fileSha256,
    options.existingFileHashes
  );
}
function parseZipArtifactSummary(fd, fileSize) {
  let artifact;
  try {
    artifact = extractWhatsAppChatArtifactFromFile(fd, fileSize);
  } catch (err) {
    if (err instanceof WhatsAppZipPolicyRejection) {
      return "too_large";
    }
    throw err;
  }
  if (!artifact) {
    return null;
  }
  try {
    const summary = scanWhatsAppChatIdentity(
      artifact.chatFileName,
      splitWhatsAppChatLines(artifact.text)
    );
    return {
      format: artifact.format,
      mediaFileCount: artifact.mediaFileCount,
      summary
    };
  } catch (err) {
    if (err instanceof WhatsAppMessageLimitExceededError) {
      return "too_large";
    }
    throw err;
  }
}
async function parseTextArtifactSummary(path, displayFileName) {
  if (statSync3(path).size === 0) {
    return null;
  }
  let sawExportShapedLine = false;
  async function* sniffedLines(rawLines) {
    for await (const line of rawLines) {
      if (!sawExportShapedLine && looksLikeWhatsAppChatExport(line)) {
        sawExportShapedLine = true;
      }
      yield line;
    }
  }
  const stream = createReadStream4(path, { encoding: "utf8" });
  const lines = createInterface({
    crlfDelay: Number.POSITIVE_INFINITY,
    input: stream
  });
  let summary;
  try {
    summary = await scanWhatsAppChatIdentityStream(
      displayFileName,
      sniffedLines(lines)
    );
  } catch (err) {
    if (err instanceof WhatsAppMessageLimitExceededError) {
      return "too_large";
    }
    throw err;
  }
  if (!sawExportShapedLine) {
    return null;
  }
  return { format: "whatsapp_chat_export", mediaFileCount: 0, summary };
}

// packages/polyfill-connectors/src/manual-upload-validation.ts
function existingFileHashesOption(existingFileHashes) {
  return existingFileHashes === void 0 ? {} : { existingFileHashes };
}
function fileNameOption(fileName) {
  return fileName === void 0 ? {} : { fileName };
}
function validateManualUploadArtifactByKind(kind, input, options = {}) {
  const maxFileBytes = options.maxFileBytes ?? null;
  if (kind === "google_maps_timeline") {
    return validateGoogleMapsTimelineArtifact(input, {
      maxFileBytes
    });
  }
  if (kind === "strava_account_export") {
    return validateStravaAccountExportArtifact(input, {
      ...existingFileHashesOption(options.existingFileHashes),
      ...fileNameOption(options.fileName),
      maxFileBytes
    });
  }
  if (kind === "whatsapp_chat_export") {
    return validateWhatsAppChatExportArtifact(input, {
      fileName: options.fileName ?? null,
      maxFileBytes
    });
  }
  if (kind === "netflix_viewing_activity") {
    return validateNetflixExportArtifact(input, {
      fileName: options.fileName ?? null,
      maxFileBytes
    });
  }
  return null;
}
async function validateManualUploadArtifactFromFileByKind(kind, fd, fileSize, options) {
  if (kind === "apple_health_export") {
    return await validateAppleHealthExportArtifactFromFile(
      fd,
      options.filePath,
      fileSize,
      {
        fileName: options.fileName,
        fileSha256: options.fileSha256,
        maxFileBytes: options.maxFileBytes ?? null
      }
    );
  }
  if (kind === "whatsapp_chat_export") {
    return await validateWhatsAppChatExportArtifactFromFile(
      fd,
      options.filePath,
      fileSize,
      {
        fileName: options.fileName,
        fileSha256: options.fileSha256,
        maxFileBytes: options.maxFileBytes ?? null
      }
    );
  }
  if (kind === "netflix_viewing_activity") {
    return validateNetflixExportArtifactFromFile(
      fd,
      options.fileName,
      fileSize,
      {
        fileName: options.fileName,
        fileSha256: options.fileSha256,
        maxFileBytes: options.maxFileBytes ?? null
      }
    );
  }
  if (kind === "google_maps_timeline") {
    return await validateGoogleMapsTimelineArtifactFromFile(
      options.filePath,
      fileSize,
      {
        fileSha256: options.fileSha256,
        maxFileBytes: options.maxFileBytes ?? null
      }
    );
  }
  if (kind === "strava_account_export") {
    return await validateStravaAccountExportArtifactFromFile(
      fd,
      options.filePath,
      fileSize,
      {
        ...existingFileHashesOption(options.existingFileHashes),
        fileName: options.fileName,
        fileSha256: options.fileSha256,
        maxFileBytes: options.maxFileBytes ?? null
      }
    );
  }
  return null;
}

// packages/polyfill-connectors/src/provider-auth-adapters.ts
init_provider_auth_adapter();
var ADAPTER_MODULES = [
  async () => {
    const { OAUTH2_GENERIC_EXCHANGER_KIND: OAUTH2_GENERIC_EXCHANGER_KIND2, oauth2GenericAdapter: oauth2GenericAdapter2 } = await Promise.resolve().then(() => (init_oauth2_generic_provider_auth(), oauth2_generic_provider_auth_exports));
    return {
      adapter: oauth2GenericAdapter2,
      kind: OAUTH2_GENERIC_EXCHANGER_KIND2
    };
  },
  async () => {
    const {
      GOOGLE_DATA_PORTABILITY_EXCHANGER_KIND: GOOGLE_DATA_PORTABILITY_EXCHANGER_KIND2,
      googleDataPortabilityAdapter: googleDataPortabilityAdapter2
    } = await Promise.resolve().then(() => (init_provider_auth(), provider_auth_exports));
    return {
      adapter: googleDataPortabilityAdapter2,
      kind: GOOGLE_DATA_PORTABILITY_EXCHANGER_KIND2
    };
  }
];
var loaded = null;
function loadProviderAuthAdapterModules() {
  loaded ??= Promise.all(ADAPTER_MODULES.map((load) => load())).then(
    (entries) => {
      for (const { adapter, kind } of entries) {
        registerProviderAuthAdapter(kind, adapter);
      }
    }
  );
  return loaded;
}
async function resolveProviderAuthAdapter(kind) {
  await loadProviderAuthAdapterModules();
  return getRegisteredProviderAuthAdapter(kind);
}
export {
  resolveProviderAuthAdapter,
  validateManualUploadArtifactByKind,
  validateManualUploadArtifactFromFileByKind
};
