import type { ActivityResponse } from '@openrouter/sdk/models/index.js';
import type { GetCreditsResponse } from '@openrouter/sdk/models/operations/index.js';
import { OpenRouter } from '@openrouter/sdk/sdk/sdk.js';

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
  constructor(message: string) {
    super(message);
    this.name = 'ApiError';
  }
}
