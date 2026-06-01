import { describe, expect, it } from 'vitest';
import type { Model as SDKModel } from '@openrouter/sdk/models/index.js';
import type {
  CreateKeysData,
  GetCurrentKeyData,
  ListData,
  UpdateKeysData,
} from '@openrouter/sdk/models/operations/index.js';
import {
  normalizeOpenRouterModel,
  normalizeSdkKeyMetadata,
  sdkModelToOpenRouterModel,
} from '../normalizers.js';
import { createValidModel } from './fixtures.js';

function createSdkModel(overrides: Partial<SDKModel> = {}): SDKModel {
  return {
    architecture: {
      inputModalities: ['text'],
      modality: 'text',
      outputModalities: ['text'],
    },
    canonicalSlug: 'test/model',
    contextLength: 128000,
    created: 0,
    defaultParameters: null,
    id: 'test/model',
    links: {} as SDKModel['links'],
    name: 'Test Model',
    perRequestLimits: null,
    pricing: {
      prompt: '0.0000005',
      completion: '0.0000015',
    },
    supportedParameters: [],
    topProvider: {
      isModerated: false,
    },
    ...overrides,
  };
}

function createCurrentKeyData(overrides: Partial<GetCurrentKeyData> = {}): GetCurrentKeyData {
  return {
    byokUsage: 0,
    byokUsageDaily: 0,
    byokUsageMonthly: 0,
    byokUsageWeekly: 0,
    creatorUserId: null,
    includeByokInLimit: true,
    isFreeTier: false,
    isManagementKey: false,
    isProvisioningKey: false,
    label: 'sk-or-v1-current',
    limit: 100,
    limitRemaining: 40,
    limitReset: 'monthly',
    rateLimit: {
      interval: 'day',
      note: 'deprecated',
      requests: -1,
    },
    usage: 60,
    usageDaily: 0,
    usageMonthly: 0,
    usageWeekly: 0,
    ...overrides,
  };
}

function createListKeyData(overrides: Partial<ListData> = {}): ListData {
  return {
    byokUsage: 0,
    byokUsageDaily: 0,
    byokUsageMonthly: 0,
    byokUsageWeekly: 0,
    createdAt: '2026-05-22T00:00:00.000Z',
    creatorUserId: null,
    disabled: false,
    hash: 'hash-123',
    includeByokInLimit: true,
    label: 'sk-or-v1-list',
    limit: 100,
    limitRemaining: 40,
    limitReset: 'monthly',
    name: 'Workspace Key',
    updatedAt: null,
    usage: 60,
    usageDaily: 0,
    usageMonthly: 0,
    usageWeekly: 0,
    workspaceId: 'ws-1',
    ...overrides,
  };
}

function createCreateKeysData(overrides: Partial<CreateKeysData> = {}): CreateKeysData {
  return {
    byokUsage: 0,
    byokUsageDaily: 0,
    byokUsageMonthly: 0,
    byokUsageWeekly: 0,
    createdAt: '2026-05-22T00:00:00.000Z',
    creatorUserId: null,
    disabled: false,
    hash: 'hash-create',
    includeByokInLimit: true,
    label: 'sk-or-v1-create',
    limit: 100,
    limitRemaining: 40,
    limitReset: 'weekly',
    name: 'Created Key',
    updatedAt: null,
    usage: 60,
    usageDaily: 0,
    usageMonthly: 0,
    usageWeekly: 0,
    workspaceId: 'ws-create',
    ...overrides,
  };
}

function createUpdateKeysData(overrides: Partial<UpdateKeysData> = {}): UpdateKeysData {
  return {
    byokUsage: 0,
    byokUsageDaily: 0,
    byokUsageMonthly: 0,
    byokUsageWeekly: 0,
    createdAt: '2026-05-22T00:00:00.000Z',
    creatorUserId: null,
    disabled: false,
    hash: 'hash-update',
    includeByokInLimit: false,
    label: 'sk-or-v1-update',
    limit: 100,
    limitRemaining: 40,
    limitReset: null,
    name: 'Updated Key',
    updatedAt: null,
    usage: 60,
    usageDaily: 0,
    usageMonthly: 0,
    usageWeekly: 0,
    workspaceId: 'ws-update',
    ...overrides,
  };
}

describe('sdkModelToOpenRouterModel', () => {
  it('normalizes SDK camelCase fields into canonical snake_case model shape', () => {
    const normalized = sdkModelToOpenRouterModel(
      createSdkModel({
        architecture: {
          inputModalities: ['text', 'image'],
          modality: 'text',
          outputModalities: ['text'],
        },
        contextLength: null,
        perRequestLimits: { completionTokens: 0, promptTokens: 123 },
        pricing: {
          prompt: '0.0000005',
          completion: '0.0000015',
          inputCacheRead: undefined,
          inputCacheWrite: undefined,
        },
        supportedParameters: ['reasoning'],
        topProvider: {
          contextLength: null,
          isModerated: false,
          maxCompletionTokens: null,
        },
      }),
    );

    expect(normalized).toEqual({
      id: 'test/model',
      name: 'Test Model',
      architecture: {
        input_modalities: ['text', 'image'],
        output_modalities: ['text'],
      },
      context_length: 0,
      pricing: {
        prompt: '0.0000005',
        completion: '0.0000015',
        input_cache_read: '0',
        input_cache_write: '0',
      },
      supported_parameters: ['reasoning'],
      top_provider: {
        context_length: 0,
        max_completion_tokens: 0,
      },
      per_request_limits: {
        completion_tokens: 0,
      },
    });
  });

  it('omits optional provider/request blocks when the SDK omits them', () => {
    const normalized = sdkModelToOpenRouterModel(
      createSdkModel({
        topProvider: null as unknown as SDKModel['topProvider'],
        perRequestLimits: null,
      }),
    );

    expect(normalized).not.toHaveProperty('top_provider');
    expect(normalized).not.toHaveProperty('per_request_limits');
  });

  it('leaves canonical models unchanged when normalization is a no-op', () => {
    const model = createValidModel({
      top_provider: { context_length: 64000, max_completion_tokens: 8192 },
      per_request_limits: { completion_tokens: 4096 },
    });

    expect(normalizeOpenRouterModel(model)).toBe(model);
  });

  it('guards against null architecture without crashing', () => {
    const normalized = sdkModelToOpenRouterModel(
      createSdkModel({
        architecture: null as unknown as SDKModel['architecture'],
      }),
    );

    expect(normalized).toMatchObject({
      id: 'test/model',
      name: 'Test Model',
      context_length: 128000,
      pricing: {
        prompt: '0.0000005',
        completion: '0.0000015',
      },
    });
    expect(normalized).not.toHaveProperty('architecture');
  });

  it('guards against null pricing without pretending the model is free', () => {
    const normalized = sdkModelToOpenRouterModel(
      createSdkModel({
        pricing: null as unknown as SDKModel['pricing'],
      }),
    );

    expect(normalized).toMatchObject({
      id: 'test/model',
      name: 'Test Model',
      context_length: 128000,
    });
    expect(normalized).not.toHaveProperty('pricing');
  });

  it('guards against undefined architecture without crashing', () => {
    const normalized = sdkModelToOpenRouterModel(
      createSdkModel({
        architecture: undefined as unknown as SDKModel['architecture'],
      }),
    );

    expect(normalized).not.toHaveProperty('architecture');
    expect(normalized.pricing).toBeDefined();
  });

  it('guards against undefined pricing without crashing', () => {
    const normalized = sdkModelToOpenRouterModel(
      createSdkModel({
        pricing: undefined as unknown as SDKModel['pricing'],
      }),
    );

    expect(normalized).not.toHaveProperty('pricing');
  });
});

describe('normalizeSdkKeyMetadata', () => {
  it('preserves zero limits and zero remaining distinctly from absent values', () => {
    const normalized = normalizeSdkKeyMetadata(
      createCurrentKeyData({
        includeByokInLimit: false,
        limit: 0,
        limitRemaining: 0,
        limitReset: 'DAILY',
        usage: 0,
      }),
    );

    expect(normalized).toMatchObject({
      name: 'sk-or-v1-current',
      label: 'sk-or-v1-current',
      used: 0,
      limit: 0,
      remaining: 0,
      byok: 'excl',
      resetCadence: 'daily',
      disabled: false,
    });
    expect(normalized).not.toHaveProperty('hash');
    expect('limit' in normalized).toBe(true);
    expect('remaining' in normalized).toBe(true);
  });

  it('omits null limits and keeps unknown byok/reset cases partial', () => {
    const normalized = normalizeSdkKeyMetadata(
      createCurrentKeyData({
        includeByokInLimit: undefined as never,
        limit: null,
        limitRemaining: null,
        limitReset: undefined as never,
      }),
    );

    expect(normalized).toMatchObject({
      name: 'sk-or-v1-current',
      byok: '?',
      resetCadence: 'partial',
      disabled: false,
    });
    expect(normalized).not.toHaveProperty('hash');
    expect(normalized).not.toHaveProperty('limit');
    expect(normalized).not.toHaveProperty('remaining');
  });

  it('keeps list-only metadata such as name, hash, disabled, and never resets', () => {
    const normalized = normalizeSdkKeyMetadata(
      createListKeyData({
        disabled: true,
        includeByokInLimit: true,
        limitReset: 'never',
      }),
    );

    expect(normalized).toMatchObject({
      name: 'Workspace Key',
      label: 'sk-or-v1-list',
      byok: 'incl',
      resetCadence: 'never',
      hash: 'hash-123',
      disabled: true,
      limit: 100,
      remaining: 40,
    });
  });

  it('normalizes create responses with weekly resets', () => {
    const normalized = normalizeSdkKeyMetadata(createCreateKeysData());

    expect(normalized).toMatchObject({
      name: 'Created Key',
      label: 'sk-or-v1-create',
      byok: 'incl',
      resetCadence: 'weekly',
      hash: 'hash-create',
      disabled: false,
    });
  });

  it('treats null limitReset in update responses as never', () => {
    const normalized = normalizeSdkKeyMetadata(createUpdateKeysData());

    expect(normalized).toMatchObject({
      name: 'Updated Key',
      label: 'sk-or-v1-update',
      byok: 'excl',
      resetCadence: 'never',
      hash: 'hash-update',
      disabled: false,
    });
  });
});
