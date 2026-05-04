import type { CreditsResponse, AnalyticsResponse } from './types.js';

/**
 * OpenRouter API client for pi-openrouter extension.
 *
 * API Reference: https://openrouter.ai/docs/api
 *
 * Available endpoints:
 * - GET /api/v1/credits - Get user credit balance and usage
 * - GET /api/v1/activity - Get user activity (analytics by model)
 *
 * Environment variables:
 * - OPENROUTER_API_KEY - Regular user API key (for /credits, limited /activity)
 * - OPENROUTER_MANAGEMENT_KEY - Management key (for full /activity analytics)
 *
 * Error handling:
 * - AuthError: Neither OPENROUTER_API_KEY nor OPENROUTER_MANAGEMENT_KEY set
 * - ApiError: HTTP error from OpenRouter API
 */

const API_BASE = 'https://openrouter.ai/api/v1';

export function getApiKey(): string | undefined {
  const key = process.env['OPENROUTER_MANAGEMENT_KEY'] || process.env['OPENROUTER_API_KEY'];
  return key;
}

export async function fetchCredits(): Promise<CreditsResponse> {
  const key = getApiKey();
  if (!key) throw new AuthError('OPENROUTER_API_KEY or OPENROUTER_MANAGEMENT_KEY not set');

  const res = await fetch(`${API_BASE}/credits`, {
    headers: { Authorization: `Bearer ${key}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(`Credits fetch failed: ${res.status} ${res.statusText} - ${text}`);
  }
  return res.json() as Promise<CreditsResponse>;
}

export async function fetchActivity(): Promise<AnalyticsResponse> {
  const key = getApiKey();
  if (!key) throw new AuthError('OPENROUTER_API_KEY or OPENROUTER_MANAGEMENT_KEY not set');

  const res = await fetch(`${API_BASE}/activity`, {
    headers: { Authorization: `Bearer ${key}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(`Activity fetch failed: ${res.status} ${res.statusText} - ${text}`);
  }
  return res.json() as Promise<AnalyticsResponse>;
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
