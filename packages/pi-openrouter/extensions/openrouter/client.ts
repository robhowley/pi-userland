import type { ActivityResponse } from '@openrouter/sdk/models/index.js';
import type { GetCreditsResponse } from '@openrouter/sdk/models/operations/index.js';
import { OpenRouter } from '@openrouter/sdk/sdk/sdk.js';
import type { ModelsListResponse } from '@openrouter/sdk/models/index.js';

let client: OpenRouter | null = null;

function getClient(): OpenRouter | null {
  if (client) return client;
  const apiKey = process.env['OPENROUTER_MANAGEMENT_KEY'] || process.env['OPENROUTER_API_KEY'];
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
 * Uses direct fetch to the /models/user endpoint.
 */
export async function fetchUserModels(): Promise<ModelsListResponse> {
  const key = getApiKey();
  if (!key) {
    throw new AuthError('OPENROUTER_API_KEY not set');
  }

  const response = await fetch('https://openrouter.ai/api/v1/models/user', {
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const status = response.status || 0;
    let message: string;

    switch (status) {
      case 401:
        message = 'Unauthorized: Invalid or missing OpenRouter API key';
        break;
      case 429:
        message = 'Rate limited: Too many requests to OpenRouter';
        break;
      case 500:
      case 502:
      case 503:
        message = `OpenRouter server error (${status})`;
        break;
      default:
        message = `Models fetch failed: ${status} ${response.statusText}`;
    }

    throw new ApiError(message, status);
  }

  const data = (await response.json()) as ModelsListResponse;

  // Validate response structure
  if (!data || !Array.isArray(data.data)) {
    throw new ApiError('Invalid response format from OpenRouter');
  }

  return data;
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

interface SDKError {
  status?: number;
  message?: string;
}

function isSDKError(err: unknown): err is SDKError {
  return err !== null && typeof err === 'object' && 'status' in err;
}

function mapSdkError(err: unknown): Error {
  if (isSDKError(err)) {
    const status = err.status;
    const message = err.message ?? 'Unknown error';
    if (status === 401) return new AuthError(message);
    return new ApiError(`${status}: ${message}`);
  }
  if (err instanceof Error) return err;
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
