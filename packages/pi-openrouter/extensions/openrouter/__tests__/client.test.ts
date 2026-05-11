import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchUserModels, isConfigured, getApiKey, ApiError, AuthError } from '../client.js';

// Mock SDK at the module level
vi.mock('@openrouter/sdk/sdk/sdk.js', () => ({
  OpenRouter: vi.fn(),
}));

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

  it('should fetch models with SDK', async () => {
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

    // Mock SDK OpenRouter class
    const MockOpenRouter = vi.mocked((await import('@openrouter/sdk/sdk/sdk.js')).OpenRouter);
    const mockClient = {
      models: { listForUser: vi.fn().mockResolvedValue(mockResponse) },
      credits: {},
      analytics: {},
      chat: {},
      embeddings: {},
      images: {},
      fine_tuning: {},
      batches: {},
      files: {},
      audio: {},
      moderation: {},
      beta: {},
      webhooks: {},
      fineTunes: {},
      jobs: {},
      uploads: {},
      assistants: {},
      threads: {},
      runs: {},
      messages: {},
      vectorStores: {},
      tools: {},
    };
    MockOpenRouter.mockImplementation(() => mockClient as any);

    const result = await fetchUserModels();

    expect(result!.data).toHaveLength(1);
    expect(result!.data[0]!.id).toBe('openai/gpt-4');
    expect(mockClient.models.listForUser).toHaveBeenCalled();
  });

  it('should throw ApiError on 401 unauthorized', async () => {
    process.env['OPENROUTER_API_KEY'] = 'invalid-key';

    const MockOpenRouter = vi.mocked((await import('@openrouter/sdk/sdk/sdk.js')).OpenRouter);
    const mockClient = {
      models: { listForUser: vi.fn().mockRejectedValue(new Error('Unauthorized')) },
      credits: {},
      analytics: {},
      chat: {},
      embeddings: {},
      images: {},
      fine_tuning: {},
      batches: {},
      files: {},
      audio: {},
      moderation: {},
      beta: {},
      webhooks: {},
      fineTunes: {},
      jobs: {},
      uploads: {},
      assistants: {},
      threads: {},
      runs: {},
      messages: {},
      vectorStores: {},
      tools: {},
    };
    MockOpenRouter.mockImplementation(() => mockClient as any);

    const error = await fetchUserModels().catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain('Unauthorized');
    expect((error as ApiError).statusCode).toBe(401);
  });

  it('should throw ApiError on rate limit (429)', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';

    const MockOpenRouter = vi.mocked((await import('@openrouter/sdk/sdk/sdk.js')).OpenRouter);
    const mockClient = {
      models: { listForUser: vi.fn().mockRejectedValue(new Error('Rate limited')) },
      credits: {},
      analytics: {},
      chat: {},
      embeddings: {},
      images: {},
      fine_tuning: {},
      batches: {},
      files: {},
      audio: {},
      moderation: {},
      beta: {},
      webhooks: {},
      fineTunes: {},
      jobs: {},
      uploads: {},
      assistants: {},
      threads: {},
      runs: {},
      messages: {},
      vectorStores: {},
      tools: {},
    };
    MockOpenRouter.mockImplementation(() => mockClient as any);

    const error = await fetchUserModels().catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain('Rate limited');
    expect((error as ApiError).statusCode).toBe(429);
  });

  it('should throw ApiError on server error', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';

    const MockOpenRouter = vi.mocked((await import('@openrouter/sdk/sdk/sdk.js')).OpenRouter);
    const mockClient = {
      models: { listForUser: vi.fn().mockRejectedValue(new Error('Server error')) },
      credits: {},
      analytics: {},
      chat: {},
      embeddings: {},
      images: {},
      fine_tuning: {},
      batches: {},
      files: {},
      audio: {},
      moderation: {},
      beta: {},
      webhooks: {},
      fineTunes: {},
      jobs: {},
      uploads: {},
      assistants: {},
      threads: {},
      runs: {},
      messages: {},
      vectorStores: {},
      tools: {},
    };
    MockOpenRouter.mockImplementation(() => mockClient as any);

    const error = await fetchUserModels().catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain('Server error');
    expect((error as ApiError).statusCode).toBe(500);
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
