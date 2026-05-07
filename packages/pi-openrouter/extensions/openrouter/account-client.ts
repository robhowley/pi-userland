import { OpenRouter } from '@openrouter/sdk/sdk/sdk.js';
import type { KeyInfo } from './account-types.js';

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

export async function getAllKeys(): Promise<KeyInfo[] | null> {
  const client = getClient();
  if (!client) return null;
  try {
    const response = await client.apiKeys.list();
    const rawKeys = response.data;
    return rawKeys.map(rawToKeyInfo);
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
    return rawToKeyInfo(response.data);
  } catch (err) {
    throw mapSdkError(err);
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

function rawToKeyInfo(raw: GetCurrentKeyData | ListData): KeyInfo {
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

  // Create the object with explicit undefined for optional properties
  const keyInfo: KeyInfo = {
    label: raw.label,
    status: 'healthy',
    used,
    resetCadence,
    byok,
    hash,
    disabled,
    isCurrentSession: false,
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
