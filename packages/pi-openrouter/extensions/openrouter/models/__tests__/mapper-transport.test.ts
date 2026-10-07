import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Api, Model } from '@earendil-works/pi-ai';
import { createValidModel } from '../../__tests__/fixtures.js';
import type { ModelOverridesFile } from '../types.js';

const { loadModelOverrides, builtInModels } = vi.hoisted(() => {
  const builtInModels: Model<Api>[] = [
    {
      id: 'anthropic/model',
      name: 'Anthropic Model',
      api: 'anthropic-messages',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
      compat: { supportsTemperature: false, forceAdaptiveThinking: true },
    },
    {
      id: 'openai/model',
      name: 'OpenAI Model',
      api: 'openai-completions',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
      compat: { thinkingFormat: 'openrouter', supportsDeveloperRole: false },
    },
    {
      id: 'transport/no-compat',
      name: 'No Compat Model',
      api: 'anthropic-messages',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    },
  ];

  return {
    loadModelOverrides: vi.fn<() => Promise<ModelOverridesFile>>(),
    builtInModels,
  };
});

vi.mock('../overrides.js', () => ({
  loadModelOverrides,
  getModelOverride: (overrides: ModelOverridesFile, modelId: string) =>
    overrides.overrides[modelId],
}));

// Mirrors the shape of Pi's built-in OpenRouter catalog with complete Model values.
vi.mock('@earendil-works/pi-ai/providers/all', () => ({
  getBuiltinModels: vi.fn(() => builtInModels),
}));

import { mapOpenRouterModels } from '../mapper.js';

async function mapOne(id: string) {
  const result = await mapOpenRouterModels([createValidModel({ id })]);
  expect(result.configs).toHaveLength(1);
  return result.configs[0];
}

describe('mapOpenRouterModels built-in transport metadata', () => {
  beforeEach(() => {
    loadModelOverrides.mockResolvedValue({ version: 1, overrides: {} });
  });

  it('preserves api, baseUrl, and compat together for an Anthropic-transport model', async () => {
    expect(await mapOne('anthropic/model')).toMatchObject({
      id: 'anthropic/model',
      api: 'anthropic-messages',
      baseUrl: 'https://openrouter.ai/api',
      compat: { supportsTemperature: false, forceAdaptiveThinking: true },
    });
  });

  it('preserves OpenAI-compatible transport metadata', async () => {
    expect(await mapOne('openai/model')).toMatchObject({
      api: 'openai-completions',
      baseUrl: 'https://openrouter.ai/api/v1',
      compat: { thinkingFormat: 'openrouter', supportsDeveloperRole: false },
    });
  });

  it('preserves a transport that declares no compat', async () => {
    const config = await mapOne('transport/no-compat');

    expect(config).toMatchObject({
      api: 'anthropic-messages',
      baseUrl: 'https://openrouter.ai/api',
    });
    expect(config).not.toHaveProperty('compat');
  });

  it('leaves transport fields unset for models absent from the built-in registry', async () => {
    const config = await mapOne('unknown/model');

    expect(config).not.toHaveProperty('api');
    expect(config).not.toHaveProperty('baseUrl');
    expect(config).not.toHaveProperty('compat');
  });

  it('applies transport metadata to non-reasoning models', async () => {
    const config = await mapOne('anthropic/model');

    expect(config?.reasoning).toBe(false);
    expect(config?.api).toBe('anthropic-messages');
  });
});
