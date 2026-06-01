import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@openrouter/sdk/sdk/sdk.js', () => ({
  OpenRouter: vi.fn(),
}));

vi.mock('../client.js', () => ({
  AuthError: class AuthError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'AuthError';
    }
  },
  ApiError: class ApiError extends Error {
    statusCode?: number;

    constructor(message: string, statusCode?: number) {
      super(message);
      this.name = 'ApiError';
      if (statusCode !== undefined) {
        this.statusCode = statusCode;
      }
    }
  },
}));

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

function createMockSDKClient(
  overrides: {
    create?: ReturnType<typeof vi.fn>;
    update?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return {
    credits: { getCredits: vi.fn() },
    workspaces: { list: vi.fn() },
    apiKeys: {
      create: overrides.create ?? vi.fn(),
      update: overrides.update ?? vi.fn(),
      list: vi.fn(),
      getCurrentKeyMetadata: vi.fn(),
    },
  };
}

describe('account-client api key management', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    setKeys(undefined, undefined);
  });

  it('returns a missing-api-key inventory result when no OpenRouter key is configured', async () => {
    const { getAllKeys } = await import('../account-client.js');

    await expect(getAllKeys()).resolves.toEqual({
      keys: [],
      canManageKeys: false,
      degradedReason: 'missing-api-key',
    });
  });

  it('returns an empty but manageable inventory when key listing succeeds without keys', async () => {
    setKeys(undefined, 'mgmt-key');

    const mockClient = createMockSDKClient();
    mockClient.workspaces.list.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { result: { data: [] } };
      },
    });

    const { OpenRouter } = await import('@openrouter/sdk/sdk/sdk.js');
    vi.mocked(OpenRouter).mockImplementation(() => mockClient as any);

    const { getAllKeys } = await import('../account-client.js');

    await expect(getAllKeys()).resolves.toEqual({
      keys: [],
      canManageKeys: true,
    });
  });

  it('returns an explicit degraded inventory when key management is unavailable', async () => {
    setKeys('plain-api-key', undefined);

    const mockClient = createMockSDKClient();
    mockClient.workspaces.list.mockRejectedValue({ status: 403, message: 'Forbidden' });

    const { OpenRouter } = await import('@openrouter/sdk/sdk/sdk.js');
    vi.mocked(OpenRouter).mockImplementation(() => mockClient as any);

    const { getAllKeys } = await import('../account-client.js');

    await expect(getAllKeys()).resolves.toEqual({
      keys: [],
      canManageKeys: false,
      degradedReason: 'management-unavailable',
    });
  });

  it('createApiKey sends the expected request body and returns the secret with normalized mutation state', async () => {
    setKeys(undefined, 'mgmt-key');

    const expiresAt = new Date('2026-06-01T00:00:00Z');
    const mockClient = createMockSDKClient({
      create: vi.fn().mockResolvedValue({
        key: 'sk-or-v1-created-secret',
        data: {
          byokUsage: 0,
          byokUsageDaily: 0,
          byokUsageMonthly: 0,
          byokUsageWeekly: 0,
          createdAt: '2026-05-30T00:00:00.000Z',
          creatorUserId: null,
          disabled: false,
          hash: 'hash-create',
          includeByokInLimit: false,
          label: 'sk-or-v1-created',
          limit: null,
          limitRemaining: null,
          limitReset: null,
          name: 'Team Key',
          updatedAt: null,
          usage: 0,
          usageDaily: 0,
          usageMonthly: 0,
          usageWeekly: 0,
          workspaceId: 'ws-1',
          expiresAt,
        },
      }),
    });

    const { OpenRouter } = await import('@openrouter/sdk/sdk/sdk.js');
    vi.mocked(OpenRouter).mockImplementation(() => mockClient as any);

    const { createApiKey } = await import('../account-client.js');
    const result = await createApiKey({
      name: 'Team Key',
      limit: null,
      limitReset: null,
      includeByokInLimit: false,
      workspaceId: 'ws-1',
      expiresAt,
    });

    expect(mockClient.apiKeys.create).toHaveBeenCalledWith({
      requestBody: {
        name: 'Team Key',
        limit: null,
        limitReset: null,
        includeByokInLimit: false,
        workspaceId: 'ws-1',
        expiresAt,
      },
    });
    expect(result).toMatchObject({
      key: 'sk-or-v1-created-secret',
      keyState: {
        name: 'Team Key',
        hash: 'hash-create',
        byok: 'excl',
        resetCadence: 'never',
        status: 'unbounded',
      },
    });
    expect(result.keyState).not.toHaveProperty('workspaceName');
  });

  it('setApiKeyDisabled patches disabled status and returns normalized mutation state', async () => {
    setKeys(undefined, 'mgmt-key');

    const mockClient = createMockSDKClient({
      update: vi.fn().mockResolvedValue({
        data: {
          byokUsage: 0,
          byokUsageDaily: 0,
          byokUsageMonthly: 0,
          byokUsageWeekly: 0,
          createdAt: '2026-05-30T00:00:00.000Z',
          creatorUserId: null,
          disabled: true,
          hash: 'hash-disable',
          includeByokInLimit: true,
          label: 'sk-or-v1-disable',
          limit: 100,
          limitRemaining: 100,
          limitReset: 'weekly',
          name: 'Mutable Key',
          updatedAt: null,
          usage: 0,
          usageDaily: 0,
          usageMonthly: 0,
          usageWeekly: 0,
          workspaceId: 'ws-2',
        },
      }),
    });

    const { OpenRouter } = await import('@openrouter/sdk/sdk/sdk.js');
    vi.mocked(OpenRouter).mockImplementation(() => mockClient as any);

    const { setApiKeyDisabled } = await import('../account-client.js');
    const result = await setApiKeyDisabled('hash-disable', true);

    expect(mockClient.apiKeys.update).toHaveBeenCalledWith({
      hash: 'hash-disable',
      requestBody: { disabled: true },
    });
    expect(result).toMatchObject({
      name: 'Mutable Key',
      hash: 'hash-disable',
      disabled: true,
      byok: 'incl',
      resetCadence: 'weekly',
      status: 'disabled',
    });
    expect(result).not.toHaveProperty('workspaceName');
  });

  it('requires OPENROUTER_MANAGEMENT_KEY for create operations', async () => {
    setKeys('plain-api-key', undefined);

    const { createApiKey } = await import('../account-client.js');

    await expect(createApiKey({ name: 'Team Key' })).rejects.toMatchObject({
      message: 'OPENROUTER_MANAGEMENT_KEY is required for API key management.',
    });
  });

  it('maps unauthorized create errors to a management-key-required message', async () => {
    setKeys(undefined, 'bad-mgmt-key');

    const mockClient = createMockSDKClient({
      create: vi.fn().mockRejectedValue({ status: 401, message: 'Unauthorized' }),
    });

    const { OpenRouter } = await import('@openrouter/sdk/sdk/sdk.js');
    vi.mocked(OpenRouter).mockImplementation(() => mockClient as any);

    const { createApiKey } = await import('../account-client.js');

    await expect(createApiKey({ name: 'Team Key' })).rejects.toMatchObject({
      message:
        'OPENROUTER_MANAGEMENT_KEY is required to create API keys. Set it to a valid management key.',
    });
  });

  it('maps forbidden create errors to a management-key permissions message', async () => {
    setKeys(undefined, 'mgmt-key');

    const mockClient = createMockSDKClient({
      create: vi.fn().mockRejectedValue({ status: 403, message: 'Forbidden' }),
    });

    const { OpenRouter } = await import('@openrouter/sdk/sdk/sdk.js');
    vi.mocked(OpenRouter).mockImplementation(() => mockClient as any);

    const { createApiKey } = await import('../account-client.js');

    await expect(createApiKey({ name: 'Team Key' })).rejects.toMatchObject({
      message:
        'OPENROUTER_MANAGEMENT_KEY does not have permission to create API keys. Set it to a valid management key.',
      statusCode: 403,
    });
  });

  it('requires OPENROUTER_MANAGEMENT_KEY for toggle operations', async () => {
    setKeys('plain-api-key', undefined);

    const { setApiKeyDisabled } = await import('../account-client.js');

    await expect(setApiKeyDisabled('hash-disable', true)).rejects.toMatchObject({
      message: 'OPENROUTER_MANAGEMENT_KEY is required for API key management.',
    });
  });

  it('maps unauthorized disable errors to a management-key-required message', async () => {
    setKeys(undefined, 'bad-mgmt-key');

    const mockClient = createMockSDKClient({
      update: vi.fn().mockRejectedValue({ status: 401, message: 'Unauthorized' }),
    });

    const { OpenRouter } = await import('@openrouter/sdk/sdk/sdk.js');
    vi.mocked(OpenRouter).mockImplementation(() => mockClient as any);

    const { setApiKeyDisabled } = await import('../account-client.js');

    await expect(setApiKeyDisabled('hash-disable', true)).rejects.toMatchObject({
      message:
        'OPENROUTER_MANAGEMENT_KEY is required to disable API keys. Set it to a valid management key.',
    });
  });

  it('maps forbidden enable errors to a management-key permissions message', async () => {
    setKeys(undefined, 'mgmt-key');

    const mockClient = createMockSDKClient({
      update: vi.fn().mockRejectedValue({ status: 403, message: 'Forbidden' }),
    });

    const { OpenRouter } = await import('@openrouter/sdk/sdk/sdk.js');
    vi.mocked(OpenRouter).mockImplementation(() => mockClient as any);

    const { setApiKeyDisabled } = await import('../account-client.js');

    await expect(setApiKeyDisabled('hash-enable', false)).rejects.toMatchObject({
      message:
        'OPENROUTER_MANAGEMENT_KEY does not have permission to enable API keys. Set it to a valid management key.',
      statusCode: 403,
    });
  });

  it('preserves not-found update messages and status codes', async () => {
    setKeys(undefined, 'mgmt-key');

    const mockClient = createMockSDKClient({
      update: vi.fn().mockRejectedValue({ status: 404, message: 'Key not found' }),
    });

    const { OpenRouter } = await import('@openrouter/sdk/sdk/sdk.js');
    vi.mocked(OpenRouter).mockImplementation(() => mockClient as any);

    const { setApiKeyDisabled } = await import('../account-client.js');

    await expect(setApiKeyDisabled('missing-hash', true)).rejects.toMatchObject({
      message: 'Key not found',
      statusCode: 404,
    });
  });
});
