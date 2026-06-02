import type { CreateKeysRequestBody } from '@openrouter/sdk/models/operations/index.js';
import { OpenRouter } from '@openrouter/sdk/sdk/sdk.js';
import type { CurrentKeyRelation, KeyInfo, KeyStatus } from './account-types.js';

// Re-export error types from client.ts
import { AuthError, ApiError } from './client.js';
import { normalizeSdkKeyMetadata } from './normalizers.js';

let client: OpenRouter | null = null;
let clientApiKey: string | null = null;

function getClientForApiKey(apiKey: string): OpenRouter {
  if (client && clientApiKey === apiKey) {
    return client;
  }

  client = new OpenRouter({ apiKey });
  clientApiKey = apiKey;
  return client;
}

function getUsageOrManagementApiKey(): string | undefined {
  const managementKey = process.env['OPENROUTER_MANAGEMENT_KEY'];
  if (managementKey && managementKey.trim() !== '') {
    return managementKey;
  }

  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (apiKey && apiKey.trim() !== '') {
    return apiKey;
  }

  return undefined;
}

function getClient(): OpenRouter | null {
  const apiKey = getUsageOrManagementApiKey();
  if (!apiKey) return null;
  return getClientForApiKey(apiKey);
}

function getManagementClient(): OpenRouter {
  const apiKey = process.env['OPENROUTER_MANAGEMENT_KEY'];
  if (!apiKey || apiKey.trim() === '') {
    throw new AuthError('OPENROUTER_MANAGEMENT_KEY is required for API key management.');
  }
  return getClientForApiKey(apiKey);
}

// =============================================================================
// Account Credits API
// =============================================================================

export async function getAccountCredits(): Promise<number | null> {
  const client = getClient();
  if (!client) return null;
  try {
    const response = await client.credits.getCredits();
    return response.data.totalCredits ?? null;
  } catch (err) {
    throw mapSdkError(err);
  }
}

// =============================================================================
// Key Management API
// =============================================================================

// Workspace ID for the default workspace (empty string) - used when workspaceId is not specified
const DEFAULT_WORKSPACE_ID = '';

export type KeyInventoryDegradedReason = 'management-unavailable' | 'missing-api-key';

export interface KeyInventoryResult {
  keys: KeyInfo[];
  canManageKeys: boolean;
  degradedReason?: KeyInventoryDegradedReason;
}

export async function getAllKeys(): Promise<KeyInventoryResult> {
  const client = getClient();
  if (!client) {
    return {
      keys: [],
      canManageKeys: false,
      degradedReason: 'missing-api-key',
    };
  }

  try {
    // First, get all workspaces
    const workspacesResponse = await client.workspaces.list();
    const workspaces: Array<{ id: string; name: string }> = [];
    for await (const response of workspacesResponse) {
      // response.result contains the ListWorkspacesResponse with data array
      for (const workspace of response.result.data) {
        workspaces.push({ id: workspace.id, name: workspace.name });
      }
    }

    // Fetch keys from each workspace and combine them
    const allKeys: KeyInfo[] = [];

    for (const workspace of workspaces) {
      const workspaceId = workspace.id || DEFAULT_WORKSPACE_ID;
      const response = await client.apiKeys.list({ workspaceId, includeDisabled: true });
      const rawKeys = response.data;

      const keys = rawKeys.map((raw) =>
        keyMetadataToKeyInfo(normalizeSdkKeyMetadata(raw), workspace.name),
      );
      allKeys.push(...keys);
    }

    return {
      keys: allKeys,
      canManageKeys: true,
    };
  } catch (err) {
    // If management inventory is unavailable (403), fall back to current key only.
    const sdkErr = err as { status?: number; statusCode?: number };
    if ((sdkErr.status ?? sdkErr.statusCode) === 403) {
      return {
        keys: [],
        canManageKeys: false,
        degradedReason: 'management-unavailable',
      };
    }
    throw mapSdkError(err);
  }
}

export async function getCurrentKey(): Promise<KeyInfo | null> {
  const client = getClient();
  if (!client) return null;
  try {
    const response = await client.apiKeys.getCurrentKeyMetadata();
    return keyMetadataToKeyInfo(normalizeSdkKeyMetadata(response.data), 'Current Workspace');
  } catch (err) {
    throw mapSdkError(err);
  }
}

/**
 * Resolve how the current authenticated key relates to the listed inventory rows.
 *
 * OpenRouter current-key metadata does not reliably expose the stable inventory
 * hash, so we fall back to label matching and distinguish external provisioning
 * keys from genuinely unresolved identity.
 */
export async function resolveCurrentKeyRelation(keys: KeyInfo[]): Promise<CurrentKeyRelation> {
  if (keys.length === 0) {
    return { kind: 'unresolved', reason: 'no-inventory-keys' };
  }

  const client = getClient();
  if (!client) {
    return { kind: 'unresolved', reason: 'missing-api-key' };
  }

  try {
    const response = await client.apiKeys.getCurrentKeyMetadata();
    const raw = response.data;
    const currentKey = normalizeSdkKeyMetadata(raw);

    if (hasTrustedHash(currentKey.hash)) {
      const matchedByHash = keys.find((key) => key.hash === currentKey.hash);
      if (matchedByHash) {
        return {
          kind: 'inventory-match',
          hash: currentKey.hash,
          label: matchedByHash.label,
        };
      }

      if (raw.isProvisioningKey === true) {
        return { kind: 'external-provisioning', label: currentKey.label };
      }

      return {
        kind: 'unresolved',
        reason: 'current-hash-not-in-inventory',
        label: currentKey.label,
      };
    }

    const currentLabel = currentKey.label.trim();
    if (currentLabel === '') {
      return { kind: 'unresolved', reason: 'missing-current-label' };
    }

    const matchingHashes = Array.from(
      new Set(
        keys
          .filter((key) => key.label.trim() === currentLabel)
          .map((key) => (hasTrustedHash(key.hash) ? key.hash : undefined))
          .filter((hash): hash is string => hash !== undefined),
      ),
    );

    if (matchingHashes.length === 1) {
      return { kind: 'inventory-match', hash: matchingHashes[0]!, label: currentLabel };
    }

    if (matchingHashes.length > 1) {
      return { kind: 'ambiguous-label', label: currentLabel, matchingHashes };
    }

    if (raw.isProvisioningKey === true) {
      return { kind: 'external-provisioning', label: currentLabel };
    }

    return { kind: 'unresolved', reason: 'no-inventory-match', label: currentLabel };
  } catch (err) {
    throw mapSdkError(err);
  }
}

export interface CreateApiKeyInput {
  name: string;
  limit?: number | null;
  limitReset?: CreateKeysRequestBody['limitReset'];
  includeByokInLimit?: boolean;
  workspaceId?: string;
  expiresAt?: Date;
}

export type ApiKeyMutationInfo = Omit<KeyInfo, 'workspaceName'>;

export interface CreatedApiKeyResult {
  key: string;
  keyState: ApiKeyMutationInfo;
}

export async function createApiKey(input: CreateApiKeyInput): Promise<CreatedApiKeyResult> {
  const client = getManagementClient();

  const requestBody: CreateKeysRequestBody = {
    name: input.name,
  };

  if (input.limit !== undefined) {
    requestBody.limit = input.limit;
  }
  if (input.limitReset !== undefined) {
    requestBody.limitReset = input.limitReset;
  }
  if (input.includeByokInLimit !== undefined) {
    requestBody.includeByokInLimit = input.includeByokInLimit;
  }
  if (input.workspaceId !== undefined) {
    requestBody.workspaceId = input.workspaceId;
  }
  if (input.expiresAt !== undefined) {
    requestBody.expiresAt = input.expiresAt;
  }

  try {
    const response = await client.apiKeys.create({ requestBody });
    return {
      key: response.key,
      keyState: keyMetadataToMutationInfo(normalizeSdkKeyMetadata(response.data)),
    };
  } catch (err) {
    throw mapManagementSdkError(err, 'create API keys');
  }
}

export async function setApiKeyDisabled(
  hash: string,
  disabled: boolean,
): Promise<ApiKeyMutationInfo> {
  const client = getManagementClient();

  try {
    const response = await client.apiKeys.update({
      hash,
      requestBody: {
        disabled,
      },
    });

    return keyMetadataToMutationInfo(normalizeSdkKeyMetadata(response.data));
  } catch (err) {
    throw mapManagementSdkError(err, `${disabled ? 'disable' : 'enable'} API keys`);
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

function hasTrustedHash(hash?: string): hash is string {
  return typeof hash === 'string' && hash.trim() !== '';
}

function keyMetadataToMutationInfo(
  metadata: ReturnType<typeof normalizeSdkKeyMetadata>,
): ApiKeyMutationInfo {
  const { name, label, used, limit, remaining, resetCadence, byok, hash, disabled } = metadata;

  // Calculate status based on usage percentage
  let status: KeyStatus;
  if (disabled) {
    status = 'disabled';
  } else if (limit === undefined || limit === null) {
    status = 'unbounded';
  } else if (remaining !== undefined && remaining < 0) {
    status = 'danger';
  } else if (limit === 0) {
    status = 'danger';
  } else {
    const usedPercent = (used / limit) * 100;
    if (usedPercent >= 90) {
      status = 'danger';
    } else if (usedPercent >= 70) {
      status = 'caution';
    } else {
      status = 'healthy';
    }
  }

  const keyState: ApiKeyMutationInfo = {
    name,
    label,
    status,
    used,
    spend: used, // spend is the same as usage (in USD)
    resetCadence,
    byok,
    disabled,
  };

  if (hash !== undefined) {
    keyState.hash = hash;
  }
  if (limit !== undefined) {
    keyState.limit = limit;
  }
  if (remaining !== undefined) {
    keyState.remaining = remaining;
  }

  return keyState;
}

function keyMetadataToKeyInfo(
  metadata: ReturnType<typeof normalizeSdkKeyMetadata>,
  workspaceName: string,
): KeyInfo {
  return {
    ...keyMetadataToMutationInfo(metadata),
    workspaceName,
  };
}

function mapSdkError(err: unknown): Error {
  const rawErr = err as { status?: number; statusCode?: number; message?: string };
  const status = rawErr.status ?? rawErr.statusCode;
  const message = rawErr.message ?? 'Unknown error';

  if (status === 401) {
    return new AuthError(message);
  }
  if (status === 403) {
    return new ApiError(`Forbidden: ${message}`, 403);
  }
  if (status !== undefined) {
    return new ApiError(message, status);
  }

  if (err instanceof Error) return err;
  return new Error(String(err));
}

function mapManagementSdkError(err: unknown, action: string): Error {
  const rawErr = err as { status?: number; statusCode?: number; message?: string };
  const status = rawErr.status ?? rawErr.statusCode;
  const message = rawErr.message ?? 'Unknown error';

  if (status === 401) {
    return new AuthError(
      `OPENROUTER_MANAGEMENT_KEY is required to ${action}. Set it to a valid management key.`,
    );
  }

  if (status === 403) {
    return new ApiError(
      `OPENROUTER_MANAGEMENT_KEY does not have permission to ${action}. Set it to a valid management key.`,
      403,
    );
  }

  if (err instanceof Error && /unauthorized/i.test(err.message)) {
    return new AuthError(
      `OPENROUTER_MANAGEMENT_KEY is required to ${action}. Set it to a valid management key.`,
    );
  }

  if (err instanceof Error && /forbidden/i.test(err.message)) {
    return new ApiError(
      `OPENROUTER_MANAGEMENT_KEY does not have permission to ${action}. Set it to a valid management key.`,
      403,
    );
  }

  if (status === 400) {
    return new ApiError(message, 400);
  }

  return mapSdkError(err);
}
