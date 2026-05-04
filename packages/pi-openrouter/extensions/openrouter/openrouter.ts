import type { CreditsResponse, AnalyticsResponse } from './types.js';

const API_BASE = 'https://openrouter.ai/api/v1';

export function getApiKey(): string | undefined {
  return process.env['OPENROUTER_API_KEY'];
}

export async function fetchCredits(): Promise<CreditsResponse> {
  const key = getApiKey();
  if (!key) throw new AuthError('OPENROUTER_API_KEY not set');

  const res = await fetch(`${API_BASE}/credits`, {
    headers: { Authorization: `Bearer ${key}` },
  });

  if (!res.ok) throw new ApiError(`Credits fetch failed: ${res.status}`);
  return res.json() as Promise<CreditsResponse>;
}

export async function fetchAnalytics(startDate: Date, endDate: Date): Promise<AnalyticsResponse> {
  const key = getApiKey();
  if (!key) throw new AuthError('OPENROUTER_API_KEY not set');

  const startStr = startDate.toISOString().split('T')[0] as string;
  const endStr = endDate.toISOString().split('T')[0] as string;

  const params = new URLSearchParams();
  params.set('start_date', startStr);
  params.set('end_date', endStr);

  const res = await fetch(`${API_BASE}/analytics?${params.toString()}`, {
    headers: { Authorization: `Bearer ${key}` },
  });

  if (!res.ok) throw new ApiError(`Analytics fetch failed: ${res.status}`);
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
