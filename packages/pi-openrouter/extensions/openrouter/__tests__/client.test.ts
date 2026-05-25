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
 * Helper to set or clear OPENROUTER_API_KEY and OPENROUTER_MANAGEMENT_KEY.
 * Pass undefined to delete the env var.
 */
function setKeys(apiKey?: string, mgmtKey?: string) {
  if (apiKey === undefined) {
    delete process.env['OPENROUTER_API_KEY'];
  } else {
    process.env['OPENROUTER_API_KEY'] = apiKey;
  }
  if (mgmtKey === undefined) {
    delete process.env['OPENROUTER_MANAGEMENT_KEY'];
  } else {
    process.env['OPENROUTER_MANAGEMENT_KEY'] = mgmtKey;
  }
}

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
    setKeys(undefined, undefined);

    await expect(fetchUserModels()).rejects.toThrow('OpenRouter API key not configured');
    await expect(fetchUserModels()).rejects.toBeInstanceOf(AuthError);
  });

  it('should fetch models with SDK', async () => {
    setKeys('test-key', undefined);

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
    setKeys('invalid-key', undefined);

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
    setKeys('test-key', undefined);

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
    setKeys('test-key', undefined);

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
    setKeys('test-key', undefined);
    expect(isConfigured()).toBe(true);
  });

  it('should return false when API key is not set', () => {
    setKeys(undefined, undefined);
    expect(isConfigured()).toBe(false);
  });

  it('should return false when API key is empty string', () => {
    setKeys('', undefined);
    expect(isConfigured()).toBe(false);
  });
});

describe('getApiKey', () => {
  beforeEach(() => {
    restoreEnv();
  });

  it('should return the API key when set', () => {
    setKeys('test-key', undefined);
    expect(getApiKey()).toBe('test-key');
  });

  it('should return undefined when API key is not set', () => {
    setKeys(undefined, undefined);
    expect(getApiKey()).toBeUndefined();
  });

  it('should return empty string when API key is empty', () => {
    setKeys('', undefined);
    expect(getApiKey()).toBe('');
  });
});

// Phase 1 regression tests
describe('getModelSyncApiKey', () => {
  beforeEach(() => {
    restoreEnv();
  });

  it.each([
    {
      apiKey: 'api-key',
      mgmtKey: 'mgmt-key',
      expected: 'api-key',
      desc: 'should return OPENROUTER_API_KEY when both keys are present',
    },
    {
      apiKey: undefined,
      mgmtKey: 'mgmt-key',
      expected: 'mgmt-key',
      desc: 'should return OPENROUTER_MANAGEMENT_KEY when only management key is present',
    },
    {
      apiKey: undefined,
      mgmtKey: undefined,
      expected: undefined,
      desc: 'should return undefined when no keys are present',
    },
    {
      apiKey: '',
      mgmtKey: 'mgmt-key',
      expected: 'mgmt-key',
      desc: 'should treat empty strings as absent',
    },
    {
      apiKey: '  ',
      mgmtKey: 'mgmt-key',
      expected: 'mgmt-key',
      desc: 'should treat whitespace-only strings as absent',
    },
  ])('$desc', ({ apiKey, mgmtKey, expected }) => {
    setKeys(apiKey, mgmtKey);
    expect(getModelSyncApiKey()).toBe(expected);
  });
});

describe('getUsageApiKey', () => {
  beforeEach(() => {
    restoreEnv();
  });

  it.each([
    {
      apiKey: 'api-key',
      mgmtKey: 'mgmt-key',
      expected: 'mgmt-key',
      desc: 'should return OPENROUTER_MANAGEMENT_KEY when both keys are present',
    },
    {
      apiKey: 'api-key',
      mgmtKey: undefined,
      expected: 'api-key',
      desc: 'should return OPENROUTER_API_KEY when only API key is present',
    },
    {
      apiKey: undefined,
      mgmtKey: undefined,
      expected: undefined,
      desc: 'should return undefined when no keys are present',
    },
    {
      apiKey: 'api-key',
      mgmtKey: '',
      expected: 'api-key',
      desc: 'should treat empty strings as absent',
    },
    {
      apiKey: '  ',
      mgmtKey: 'mgmt-key',
      expected: 'mgmt-key',
      desc: 'should treat whitespace-only strings as absent',
    },
  ])('$desc', ({ apiKey, mgmtKey, expected }) => {
    setKeys(apiKey, mgmtKey);
    expect(getUsageApiKey()).toBe(expected);
  });
});

describe('isConfiguredForModelSync', () => {
  beforeEach(() => {
    restoreEnv();
  });

  it.each([
    {
      apiKey: 'api-key',
      mgmtKey: undefined,
      expected: true,
      desc: 'should return true when API key is set',
    },
    {
      apiKey: undefined,
      mgmtKey: 'mgmt-key',
      expected: true,
      desc: 'should return true when management key is set',
    },
    {
      apiKey: undefined,
      mgmtKey: undefined,
      expected: false,
      desc: 'should return false when no keys are set',
    },
  ])('$desc', ({ apiKey, mgmtKey, expected }) => {
    setKeys(apiKey, mgmtKey);
    expect(isConfiguredForModelSync()).toBe(expected);
  });
});

describe('isConfiguredForUsage', () => {
  beforeEach(() => {
    restoreEnv();
  });

  it.each([
    {
      apiKey: undefined,
      mgmtKey: 'mgmt-key',
      expected: true,
      desc: 'should return true when management key is set',
    },
    {
      apiKey: 'api-key',
      mgmtKey: undefined,
      expected: true,
      desc: 'should return true when API key is set',
    },
    {
      apiKey: undefined,
      mgmtKey: undefined,
      expected: false,
      desc: 'should return false when no keys are set',
    },
  ])('$desc', ({ apiKey, mgmtKey, expected }) => {
    setKeys(apiKey, mgmtKey);
    expect(isConfiguredForUsage()).toBe(expected);
  });
});

describe('fetchUserModels with management key fallback', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    restoreEnv();
  });

  it('should accept OPENROUTER_MANAGEMENT_KEY when only management key is present', async () => {
    setKeys(undefined, 'mgmt-key');

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
    setKeys('api-key', 'mgmt-key');

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
    setKeys('api-key', 'mgmt-key');

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
    setKeys('api-key', undefined);

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
    setKeys('api-key', '  ');

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
    setKeys(undefined, undefined);

    const { getCredits } = await import('../client.js');
    const result = await getCredits();
    expect(result).toBeNull();
  });
});
