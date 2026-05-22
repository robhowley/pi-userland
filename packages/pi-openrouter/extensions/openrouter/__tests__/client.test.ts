import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchUserModels,
  isConfigured,
  getApiKey,
  getModelSyncApiKey,
  getUsageApiKey,
  isConfiguredForModelSync,
  isConfiguredForUsage,
  ApiError,
  AuthError,
} from '../client.js';
import { restoreEnv } from './fixtures.js';
import type { Mock } from 'vitest';

// Mock SDK at the module level
vi.mock('@openrouter/sdk/sdk/sdk.js', () => ({
  OpenRouter: vi.fn(),
}));

/**
 * Factory function to create a minimal mock SDK client.
 * Reduces boilerplate from ~25 lines to 1 line per test.
 */
function createMockSDKClient(overrides: { listForUser?: Mock; getCredits?: Mock } = {}) {
  return {
    models: { listForUser: overrides.listForUser ?? vi.fn() },
    credits: { getCredits: overrides.getCredits ?? vi.fn() },
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
}

describe('fetchUserModels', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    restoreEnv();
  });

  it('should throw AuthError when API key not set', async () => {
    delete process.env['OPENROUTER_API_KEY'];
    delete process.env['OPENROUTER_MANAGEMENT_KEY'];

    await expect(fetchUserModels()).rejects.toThrow('OpenRouter API key not configured');
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
    const mockClient = createMockSDKClient({
      listForUser: vi.fn().mockResolvedValue(mockResponse),
    });
    MockOpenRouter.mockImplementation(() => mockClient as any);

    const result = await fetchUserModels();

    expect(result!.data).toHaveLength(1);
    expect(result!.data[0]!.id).toBe('openai/gpt-4');
    expect(mockClient.models.listForUser).toHaveBeenCalled();
  });

  it('should throw ApiError on 401 unauthorized', async () => {
    process.env['OPENROUTER_API_KEY'] = 'invalid-key';

    const MockOpenRouter = vi.mocked((await import('@openrouter/sdk/sdk/sdk.js')).OpenRouter);
    const mockClient = createMockSDKClient({
      listForUser: vi.fn().mockRejectedValue(new Error('Unauthorized')),
    });
    MockOpenRouter.mockImplementation(() => mockClient as any);

    const error = await fetchUserModels().catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain('Unauthorized');
    expect((error as ApiError).statusCode).toBe(401);
  });

  it('should throw ApiError on rate limit (429)', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';

    const MockOpenRouter = vi.mocked((await import('@openrouter/sdk/sdk/sdk.js')).OpenRouter);
    const mockClient = createMockSDKClient({
      listForUser: vi.fn().mockRejectedValue(new Error('Rate limited')),
    });
    MockOpenRouter.mockImplementation(() => mockClient as any);

    const error = await fetchUserModels().catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain('Rate limited');
    expect((error as ApiError).statusCode).toBe(429);
  });

  it('should throw ApiError on server error', async () => {
    process.env['OPENROUTER_API_KEY'] = 'test-key';

    const MockOpenRouter = vi.mocked((await import('@openrouter/sdk/sdk/sdk.js')).OpenRouter);
    const mockClient = createMockSDKClient({
      listForUser: vi.fn().mockRejectedValue(new Error('Server error')),
    });
    MockOpenRouter.mockImplementation(() => mockClient as any);

    const error = await fetchUserModels().catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toContain('Server error');
    expect((error as ApiError).statusCode).toBe(500);
  });
});

describe('isConfigured', () => {
  beforeEach(() => {
    restoreEnv();
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
  beforeEach(() => {
    restoreEnv();
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

// Phase 1 regression tests
describe('getModelSyncApiKey', () => {
  beforeEach(() => {
    restoreEnv();
  });

  it('should return OPENROUTER_API_KEY when both keys are present', () => {
    process.env['OPENROUTER_API_KEY'] = 'api-key';
    process.env['OPENROUTER_MANAGEMENT_KEY'] = 'mgmt-key';
    expect(getModelSyncApiKey()).toBe('api-key');
  });

  it('should return OPENROUTER_MANAGEMENT_KEY when only management key is present', () => {
    delete process.env['OPENROUTER_API_KEY'];
    process.env['OPENROUTER_MANAGEMENT_KEY'] = 'mgmt-key';
    expect(getModelSyncApiKey()).toBe('mgmt-key');
  });

  it('should return undefined when no keys are present', () => {
    delete process.env['OPENROUTER_API_KEY'];
    delete process.env['OPENROUTER_MANAGEMENT_KEY'];
    expect(getModelSyncApiKey()).toBeUndefined();
  });

  it('should treat empty strings as absent', () => {
    process.env['OPENROUTER_API_KEY'] = '';
    process.env['OPENROUTER_MANAGEMENT_KEY'] = 'mgmt-key';
    expect(getModelSyncApiKey()).toBe('mgmt-key');
  });

  it('should treat whitespace-only strings as absent', () => {
    process.env['OPENROUTER_API_KEY'] = '  ';
    process.env['OPENROUTER_MANAGEMENT_KEY'] = 'mgmt-key';
    expect(getModelSyncApiKey()).toBe('mgmt-key');
  });
});

describe('getUsageApiKey', () => {
  beforeEach(() => {
    restoreEnv();
  });

  it('should return OPENROUTER_MANAGEMENT_KEY when both keys are present', () => {
    process.env['OPENROUTER_API_KEY'] = 'api-key';
    process.env['OPENROUTER_MANAGEMENT_KEY'] = 'mgmt-key';
    expect(getUsageApiKey()).toBe('mgmt-key');
  });

  it('should return OPENROUTER_API_KEY when only API key is present', () => {
    delete process.env['OPENROUTER_MANAGEMENT_KEY'];
    process.env['OPENROUTER_API_KEY'] = 'api-key';
    expect(getUsageApiKey()).toBe('api-key');
  });

  it('should return undefined when no keys are present', () => {
    delete process.env['OPENROUTER_API_KEY'];
    delete process.env['OPENROUTER_MANAGEMENT_KEY'];
    expect(getUsageApiKey()).toBeUndefined();
  });

  it('should treat empty strings as absent', () => {
    process.env['OPENROUTER_MANAGEMENT_KEY'] = '';
    process.env['OPENROUTER_API_KEY'] = 'api-key';
    expect(getUsageApiKey()).toBe('api-key');
  });

  it('should treat whitespace-only strings as absent', () => {
    process.env['OPENROUTER_API_KEY'] = '  ';
    process.env['OPENROUTER_MANAGEMENT_KEY'] = 'mgmt-key';
    expect(getUsageApiKey()).toBe('mgmt-key');
  });
});

describe('isConfiguredForModelSync', () => {
  beforeEach(() => {
    restoreEnv();
  });

  it('should return true when API key is set', () => {
    process.env['OPENROUTER_API_KEY'] = 'api-key';
    expect(isConfiguredForModelSync()).toBe(true);
  });

  it('should return true when management key is set', () => {
    delete process.env['OPENROUTER_API_KEY'];
    process.env['OPENROUTER_MANAGEMENT_KEY'] = 'mgmt-key';
    expect(isConfiguredForModelSync()).toBe(true);
  });

  it('should return false when no keys are set', () => {
    delete process.env['OPENROUTER_API_KEY'];
    delete process.env['OPENROUTER_MANAGEMENT_KEY'];
    expect(isConfiguredForModelSync()).toBe(false);
  });
});

describe('isConfiguredForUsage', () => {
  beforeEach(() => {
    restoreEnv();
  });

  it('should return true when management key is set', () => {
    process.env['OPENROUTER_MANAGEMENT_KEY'] = 'mgmt-key';
    expect(isConfiguredForUsage()).toBe(true);
  });

  it('should return true when API key is set', () => {
    delete process.env['OPENROUTER_MANAGEMENT_KEY'];
    process.env['OPENROUTER_API_KEY'] = 'api-key';
    expect(isConfiguredForUsage()).toBe(true);
  });

  it('should return false when no keys are set', () => {
    delete process.env['OPENROUTER_API_KEY'];
    delete process.env['OPENROUTER_MANAGEMENT_KEY'];
    expect(isConfiguredForUsage()).toBe(false);
  });
});

describe('fetchUserModels with management key fallback', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    restoreEnv();
  });

  it('should accept OPENROUTER_MANAGEMENT_KEY when only management key is present', async () => {
    delete process.env['OPENROUTER_API_KEY'];
    process.env['OPENROUTER_MANAGEMENT_KEY'] = 'mgmt-key';

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

    const MockOpenRouter = vi.mocked((await import('@openrouter/sdk/sdk/sdk.js')).OpenRouter);
    const mockClient = createMockSDKClient({
      listForUser: vi.fn().mockResolvedValue(mockResponse),
    });
    MockOpenRouter.mockImplementation(() => mockClient as any);

    const result = await fetchUserModels();
    expect(result!.data).toHaveLength(1);
    expect(mockClient.models.listForUser).toHaveBeenCalled();
    // Verify management key was used
    expect(MockOpenRouter).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'mgmt-key' }));
  });

  it('should prefer OPENROUTER_API_KEY when both keys are present', async () => {
    process.env['OPENROUTER_API_KEY'] = 'api-key';
    process.env['OPENROUTER_MANAGEMENT_KEY'] = 'mgmt-key';

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

    const MockOpenRouter = vi.mocked((await import('@openrouter/sdk/sdk/sdk.js')).OpenRouter);
    const mockClient = createMockSDKClient({
      listForUser: vi.fn().mockResolvedValue(mockResponse),
    });
    MockOpenRouter.mockImplementation(() => mockClient as any);

    await fetchUserModels();
    // Verify that the OpenRouter client was constructed with the API key, not management key
    expect(MockOpenRouter).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'api-key' }));
  });
});

describe('getCredits with usage API key selection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    restoreEnv();
    vi.resetModules(); // Clear module cache including client instance
  });

  it('should use OPENROUTER_MANAGEMENT_KEY when both keys are present', async () => {
    process.env['OPENROUTER_API_KEY'] = 'api-key';
    process.env['OPENROUTER_MANAGEMENT_KEY'] = 'mgmt-key';

    const mockResponse = {
      data: {
        total_granted: 10.0,
        total_used: 2.5,
        total_available: 7.5,
      },
    };

    const MockOpenRouter = vi.mocked((await import('@openrouter/sdk/sdk/sdk.js')).OpenRouter);
    const mockClient = createMockSDKClient({
      getCredits: vi.fn().mockResolvedValue(mockResponse),
    });
    MockOpenRouter.mockImplementation(() => mockClient as any);

    const { getCredits } = await import('../client.js');
    await getCredits();

    // Verify management key was used (not API key)
    expect(MockOpenRouter).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'mgmt-key' }));
  });

  it('should fall back to OPENROUTER_API_KEY when only API key is present', async () => {
    delete process.env['OPENROUTER_MANAGEMENT_KEY'];
    process.env['OPENROUTER_API_KEY'] = 'api-key';

    const mockResponse = {
      data: {
        total_granted: 10.0,
        total_used: 2.5,
        total_available: 7.5,
      },
    };

    const MockOpenRouter = vi.mocked((await import('@openrouter/sdk/sdk/sdk.js')).OpenRouter);
    const mockClient = createMockSDKClient({
      getCredits: vi.fn().mockResolvedValue(mockResponse),
    });
    MockOpenRouter.mockImplementation(() => mockClient as any);

    const { getCredits } = await import('../client.js');
    await getCredits();

    expect(MockOpenRouter).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'api-key' }));
  });

  it('should fall back to API key when management key is whitespace', async () => {
    process.env['OPENROUTER_MANAGEMENT_KEY'] = '  ';
    process.env['OPENROUTER_API_KEY'] = 'api-key';

    const mockResponse = {
      data: {
        total_granted: 10.0,
        total_used: 2.5,
        total_available: 7.5,
      },
    };

    const MockOpenRouter = vi.mocked((await import('@openrouter/sdk/sdk/sdk.js')).OpenRouter);
    const mockClient = createMockSDKClient({
      getCredits: vi.fn().mockResolvedValue(mockResponse),
    });
    MockOpenRouter.mockImplementation(() => mockClient as any);

    const { getCredits } = await import('../client.js');
    await getCredits();

    // Should use API key since management key is whitespace-only
    expect(MockOpenRouter).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'api-key' }));
  });

  it('should return null when no keys are configured', async () => {
    delete process.env['OPENROUTER_API_KEY'];
    delete process.env['OPENROUTER_MANAGEMENT_KEY'];

    const { getCredits } = await import('../client.js');
    const result = await getCredits();
    expect(result).toBeNull();
  });
});
