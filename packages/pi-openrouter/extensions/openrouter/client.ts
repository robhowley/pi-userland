import type { ActivityResponse } from '@openrouter/sdk/models/index.js';
import type { GetCreditsResponse } from '@openrouter/sdk/models/operations/index.js';
import { OpenRouter } from '@openrouter/sdk/sdk/sdk.js';
import type { ModelsListResponse } from '@openrouter/sdk/models/index.js';
import { UnauthorizedResponseError } from '@openrouter/sdk/models/errors/index.js';

let client: OpenRouter | null = null;

function getClient(): OpenRouter | null {
  if (client) return client;
  const apiKey = getUsageApiKey();
  if (!apiKey) return null;
  client = new OpenRouter({ apiKey });
  return client;
}

export async function getCredits(): Promise<GetCreditsResponse['data'] | null> {
  const client = getClient();
  if (!client) return null;
  try {
    const response = await client.credits.getCredits();
    return response.data;
  } catch (err) {
    throw mapSdkError(err);
  }
}

export async function getActivity(): Promise<ActivityResponse['data'] | null> {
  const client = getClient();
  if (!client) return null;
  try {
    const response = await client.analytics.getUserActivity();
    return response.data;
  } catch (err) {
    throw mapSdkError(err);
  }
}

/**
 * Fetch the authenticated user's model catalog from OpenRouter.
 * Uses the SDK for consistent error handling and retry behavior.
 */
export async function fetchUserModels(): Promise<ModelsListResponse> {
  const key = getModelSyncApiKey();
  if (!key) {
    throw new AuthError(
      'OpenRouter API key not configured. Set OPENROUTER_API_KEY or OPENROUTER_MANAGEMENT_KEY.',
    );
  }

  try {
    const sdkClient = new OpenRouter({ apiKey: key });
    const response = await sdkClient.models.listForUser({ bearer: key }, {});
    return response as ModelsListResponse;
  } catch (err: unknown) {
    throw mapSdkError(err);
  }
}

/**
 * Check if the OpenRouter API key is configured.
 */
export function isConfigured(): boolean {
  return !!getApiKey();
}

/**
 * Get the OpenRouter API key from environment.
 */
export function getApiKey(): string | undefined {
  return process.env['OPENROUTER_API_KEY'];
}

/**
 * Get the API key for usage/account endpoints.
 * Prefers OPENROUTER_MANAGEMENT_KEY for full analytics access.
 */
export function getUsageApiKey(): string | undefined {
  const mgmtKey = process.env['OPENROUTER_MANAGEMENT_KEY'];
  const apiKey = process.env['OPENROUTER_API_KEY'];
  // Treat empty strings as absent
  return mgmtKey && mgmtKey.trim() !== ''
    ? mgmtKey
    : apiKey && apiKey.trim() !== ''
      ? apiKey
      : undefined;
}

/**
 * Get the API key for model sync endpoint.
 * Prefers OPENROUTER_API_KEY but falls back to OPENROUTER_MANAGEMENT_KEY.
 */
export function getModelSyncApiKey(): string | undefined {
  const apiKey = process.env['OPENROUTER_API_KEY'];
  const mgmtKey = process.env['OPENROUTER_MANAGEMENT_KEY'];
  // Treat empty strings as absent
  return apiKey && apiKey.trim() !== ''
    ? apiKey
    : mgmtKey && mgmtKey.trim() !== ''
      ? mgmtKey
      : undefined;
}

/**
 * Check if model sync is configured.
 */
export function isConfiguredForModelSync(): boolean {
  return !!getModelSyncApiKey();
}

/**
 * Check if usage/account endpoints are configured.
 */
export function isConfiguredForUsage(): boolean {
  return !!getUsageApiKey();
}

/**
 * Map SDK errors to our error types with proper status codes.
 */
function mapSdkError(err: unknown): Error {
  // Handle UnauthorizedResponseError (401)
  if (err instanceof UnauthorizedResponseError) {
    return new ApiError('Unauthorized: Invalid or expired API key', 401);
  }

  // Handle other SDK errors with statusCode
  if (err instanceof Error && 'statusCode' in err) {
    const statusCode = (err as { statusCode: number }).statusCode;
    if (statusCode === 401) {
      return new AuthError(err.message || 'Unauthorized');
    }
    return new ApiError(err.message || 'API error', statusCode);
  }

  // Map error messages to appropriate status codes
  if (err instanceof Error) {
    const message = err.message.toLowerCase();
    if (message.includes('unauthorized')) {
      return new ApiError('Unauthorized: Invalid or expired API key', 401);
    }
    if (message.includes('rate limit') || message.includes('rate limited')) {
      return new ApiError('Rate limited: Too many requests', 429);
    }
    if (
      message.includes('server error') ||
      message.includes('internal') ||
      message.includes('service unavailable')
    ) {
      return new ApiError(err.message || 'Server error', 500);
    }
    return new ApiError(err.message || 'API error', 500);
  }

  return new Error(String(err));
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
