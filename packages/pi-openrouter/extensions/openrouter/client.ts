import type { ActivityItem, ActivityResponse } from '@openrouter/sdk/models/index.js';
import type { GetCreditsResponse } from '@openrouter/sdk/models/operations/index.js';
import { OpenRouter } from '@openrouter/sdk/sdk/sdk.js';

let client: OpenRouter | null = null;

function getClient(): OpenRouter {
  if (client) return client;
  const apiKey = process.env['OPENROUTER_MANAGEMENT_KEY'] || process.env['OPENROUTER_API_KEY'];
  if (!apiKey) throw new AuthError('OPENROUTER_API_KEY or OPENROUTER_MANAGEMENT_KEY not set');
  client = new OpenRouter({ apiKey });
  return client;
}

export async function getCredits(): Promise<GetCreditsResponse['data']> {
  try {
    const response = await getClient().credits.getCredits();
    return response.data;
  } catch (err) {
    throw mapSdkError(err);
  }
}

export async function getActivity(): Promise<ActivityResponse['data']> {
  try {
    const response = await getClient().analytics.getUserActivity();
    return response.data;
  } catch (err) {
    throw mapSdkError(err);
  }
}

function mapSdkError(err: unknown): Error {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status?: number }).status;
    const message = (err as { message?: string }).message ?? 'Unknown error';
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

export type { ActivityItem };
