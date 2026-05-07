import { OpenRouter } from '@openrouter/sdk/sdk/sdk.js';
import type { KeyInfo, KeyStatus } from './account-types.js';

// Re-export error types from client.ts
import { AuthError, ApiError } from './client.js';

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

import type { GetCurrentKeyData, ListData } from '@openrouter/sdk/models/operations/index.js';

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

    // Debug: log all workspaces and keys to file (for troubleshooting)
    const workspaceInfo = workspaces.map((w) => `  - ${w.name} (${w.id})`).join('\n');

    // Fetch keys from each workspace and combine them
    const allKeys: KeyInfo[] = [];
    const workspaceKeys: Record<string, number> = {};

    for (const workspace of workspaces) {
      const workspaceId = workspace.id || DEFAULT_WORKSPACE_ID;
      const response = await client.apiKeys.list({ workspaceId, includeDisabled: true });
      const rawKeys = response.data;

      const keys = rawKeys.map((raw) => rawToKeyInfo(raw, workspace.name));
      workspaceKeys[workspace.name] = keys.length;
      allKeys.push(...keys);
    }

    // Write debug info to file
    const fs = await import('fs');
    const os = await import('os');
    const logPath = `${os.homedir()}/.pi/debug/openrouter-account.log`;
    const dirPath = `${os.homedir()}/.pi/debug`;
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    const debugInfo = [
      `[openrouter-account] ${new Date().toISOString()}`,
      `[openrouter-account] Workspaces found: ${workspaces.length}`,
      workspaceInfo,
      '',
      `[openrouter-account] Keys per workspace:`,
      ...Object.entries(workspaceKeys).map(([name, count]) => `  - ${name}: ${count} key(s)`),
      '',
      `[openrouter-account] Total keys: ${allKeys.length}`,
    ].join('\n');
    fs.writeFileSync(logPath, `${debugInfo}\n\n`, { flag: 'a' });

    return allKeys;
  } catch (err) {
    // If management key fails, fall back to current key only
    if (err instanceof ApiError && (err as any).statusCode === 403) {
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
    return rawToKeyInfo(response.data, 'Current Workspace');
  } catch (err) {
    throw mapSdkError(err);
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

function rawToKeyInfo(raw: GetCurrentKeyData | ListData, workspaceName: string): KeyInfo {
  const used = raw.usage ?? raw.usageMonthly ?? 0;

  // limit is number | null in both GetCurrentKeyData and ListData
  const limitValue = raw.limit;

  // remaining is number | null in both types
  const remainingValue = raw.limitRemaining;

  // Determine BYOK status
  let byok: 'incl' | 'excl' | '?' = '?';
  if (raw.includeByokInLimit === true) {
    byok = 'incl';
  } else if (raw.includeByokInLimit === false) {
    byok = 'excl';
  }

  // Determine reset cadence
  let resetCadence: 'monthly' | 'daily' | 'never' | 'partial' = 'partial';
  if (raw.limitReset) {
    const reset = raw.limitReset.toLowerCase();
    if (reset === 'monthly') {
      resetCadence = 'monthly';
    } else if (reset === 'daily') {
      resetCadence = 'daily';
    } else if (reset === 'never') {
      resetCadence = 'never';
    }
  }

  // Determine hash (ListData has hash, GetCurrentKeyData doesn't)
  const hash = 'hash' in raw ? (raw as ListData).hash : 'unknown';

  // Determine name (ListData has name, GetCurrentKeyData doesn't - use label as fallback)
  const name = 'name' in raw ? (raw as ListData).name : raw.label;

  // Get disabled status (ListData has it, GetCurrentKeyData doesn't)
  const disabled = 'disabled' in raw ? (raw as ListData).disabled : false;

  // For exactOptionalPropertyTypes, we need to handle optional properties carefully
  // The SDK returns number | null but KeyInfo expects number | undefined (or just number)
  // We use type assertion to tell TypeScript that limit/remaining are either number or not set

  // When limitValue is null, we set limit to undefined (or omit it)
  // When limitValue is a number, we keep it as is
  let limit: number | undefined;
  if (limitValue !== null) {
    limit = limitValue;
  }

  let remaining: number | undefined;
  if (remainingValue !== null) {
    remaining = remainingValue;
  }

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
    if (usedPercent >= 95) {
      status = 'danger';
    } else if (usedPercent >= 85) {
      status = 'caution';
    } else if (usedPercent >= 70) {
      status = 'watch';
    } else {
      status = 'healthy';
    }
  }

  // Create the object with explicit undefined for optional properties
  const keyInfo: KeyInfo = {
    name,
    label: raw.label,
    status,
    used,
    spend: used, // spend is the same as usage (in USD)
    resetCadence,
    byok,
    hash,
    disabled,
    isCurrentSession: false,
    workspaceName,
  };

  // Set optional properties explicitly
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
