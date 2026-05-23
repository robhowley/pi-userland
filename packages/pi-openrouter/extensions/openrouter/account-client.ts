import { OpenRouter } from '@openrouter/sdk/sdk/sdk.js';
import type { KeyInfo, KeyStatus } from './account-types.js';

// Re-export error types from client.ts
import { AuthError, ApiError } from './client.js';
import { normalizeSdkKeyMetadata } from './normalizers.js';

let client: OpenRouter | null = null;

function getClient(): OpenRouter | null {
  if (client) return client;
  const apiKey = process.env['OPENROUTER_MANAGEMENT_KEY'] || process.env['OPENROUTER_API_KEY'];
  if (!apiKey) return null;
  client = new OpenRouter({ apiKey });
  return client;
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

export async function getAllKeys(): Promise<KeyInfo[] | null> {
  const client = getClient();
  if (!client) return null;

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

    return allKeys;
  } catch (err) {
    // If management key fails (403), fall back to current key only
    const sdkErr = err as { status?: number };
    if (sdkErr.status === 403) {
      return null;
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

// =============================================================================
// Helper Functions
// =============================================================================

function keyMetadataToKeyInfo(
  metadata: ReturnType<typeof normalizeSdkKeyMetadata>,
  workspaceName: string,
): KeyInfo {
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

  const keyInfo: KeyInfo = {
    name,
    label,
    status,
    used,
    spend: used, // spend is the same as usage (in USD)
    resetCadence,
    byok,
    hash,
    disabled,
    workspaceName,
  };

  if (limit !== undefined) {
    keyInfo.limit = limit;
  }
  if (remaining !== undefined) {
    keyInfo.remaining = remaining;
  }

  return keyInfo;
}

function mapSdkError(err: unknown): Error {
  const rawErr = err as { status?: number; message?: string };
  const status = rawErr.status;
  const message = rawErr.message ?? 'Unknown error';

  if (status === 401) {
    return new AuthError(message);
  }
  if (status === 403) {
    return new ApiError(`Forbidden: ${message}`);
  }

  if (err instanceof Error) return err;
  return new Error(String(err));
}

export function getCurrentKeyHash(): string | undefined {
  // For v1, we don't hash the current API key for comparison
  // This is a follow-up item from the planning docs
  return undefined;
}
