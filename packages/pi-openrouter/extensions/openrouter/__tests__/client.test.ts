import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchUserModels, isConfigured, getApiKey, ApiError, AuthError } from '../client.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('fetchUserModels', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should throw AuthError when API key not set', async () => {
    delete process.env['OPENROUTER_API_KEY'];

    await expect(fetchUserModels()).rejects.toThrow('OPENROUTER_API_KEY not set');
    await expect(fetchUserModels()).rejects.toBeInstanceOf(AuthError);
  });

  it('should fetch models with correct headers', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';

    const mockResponse = {
      data: [
        {
          id: 'openai/gpt-4',
          name: 'GPT-4',
          context_length: 8192,
          pricing: { prompt: '0.00003', completion: '0.00006' },
        },
      ],
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockResponse,
    });

    const result = await fetchUserModels();

    expect(result!.data).toHaveLength(1);
    expect(result!.data[0]!.id).toBe('openai/gpt-4');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models/user',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('should throw ApiError on 401 unauthorized', async () => {
    process.env['OPENROUTER_API_KEY'] = 'invalid-key';

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    const error = await fetchUserModels().catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain('Unauthorized');
    expect((error as ApiError).statusCode).toBe(401);
  });

  it('should throw ApiError on 429 rate limit', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    });

    const error = await fetchUserModels().catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain('Rate limited');
    expect((error as ApiError).statusCode).toBe(429);
  });

  it('should throw ApiError on server error', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    });

    const error = await fetchUserModels().catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain('server error');
    expect((error as ApiError).statusCode).toBe(503);
  });

  it('should throw ApiError on invalid response format', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ not_data: [] }),
    });

    const error = await fetchUserModels().catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain('Invalid response format');
  });
});

describe('isConfigured', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return true when API key is set', () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    expect(isConfigured()).toBe(true);
  });

  it('should return false when API key is not set', () => {
    delete process.env['OPENROUTER_API_KEY'];
    expect(isConfigured()).toBe(false);
  });

  it('should return false when API key is empty string', () => {
    process.env['OPENROUTER_API_KEY'] = '';
    expect(isConfigured()).toBe(false);
  });
});

describe('getApiKey', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should return the API key when set', () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';
    expect(getApiKey()).toBe('test-key');
  });

  it('should return undefined when API key is not set', () => {
    delete process.env['OPENROUTER_API_KEY'];
    expect(getApiKey()).toBeUndefined();
  });

  it('should return empty string when API key is empty', () => {
    process.env['OPENROUTER_API_KEY'] = '';
    expect(getApiKey()).toBe('');
  });
});
