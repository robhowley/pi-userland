import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createValidModel } from '../../__tests__/fixtures.js';
import type { ModelOverridesFile } from '../types.js';

const { loadModelOverrides } = vi.hoisted(() => ({
  loadModelOverrides: vi.fn<() => Promise<ModelOverridesFile>>(),
}));

vi.mock('../overrides.js', () => ({
  loadModelOverrides,
  getModelOverride: (overrides: ModelOverridesFile, modelId: string) =>
    overrides.overrides[modelId],
}));

// Mirrors the shape of Pi's built-in OpenRouter catalog: an Anthropic-transport entry with
// transport-specific compat, an OpenAI-compatible entry, and entries that describe a
// transport only partially.
vi.mock('@earendil-works/pi-ai/providers/all', () => ({
  getBuiltinModels: vi.fn(() => [
    {
      id: 'anthropic/model',
      api: 'anthropic-messages',
      baseUrl: 'https://openrouter.ai/api',
      compat: { supportsMidConvoEffort: true, forceAdaptiveThinking: true },
    },
    {
      id: 'openai/model',
      api: 'openai-completions',
      baseUrl: 'https://openrouter.ai/api/v1',
      compat: { thinkingFormat: 'openrouter', supportsDeveloperRole: false },
    },
    {
      id: 'transport/no-compat',
      api: 'anthropic-messages',
      baseUrl: 'https://openrouter.ai/api',
    },
    {
      id: 'transport/missing-base-url',
      api: 'anthropic-messages',
      compat: { forceAdaptiveThinking: true },
    },
    {
      id: 'transport/compat-only',
      compat: { thinkingFormat: 'openrouter' },
    },
  ]),
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
      compat: { supportsMidConvoEffort: true, forceAdaptiveThinking: true },
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
    expect(config?.compat).toBeUndefined();
  });

  it('drops a half-described transport rather than applying compat without its baseUrl', async () => {
    const config = await mapOne('transport/missing-base-url');

    expect(config?.api).toBeUndefined();
    expect(config?.baseUrl).toBeUndefined();
    expect(config?.compat).toBeUndefined();
  });

  it('keeps compat for an entry that inherits the provider-level transport', async () => {
    const config = await mapOne('transport/compat-only');

    expect(config?.api).toBeUndefined();
    expect(config?.baseUrl).toBeUndefined();
    expect(config?.compat).toEqual({ thinkingFormat: 'openrouter' });
  });

  it('leaves transport fields unset for models absent from the built-in registry', async () => {
    const config = await mapOne('unknown/model');

    expect(config?.api).toBeUndefined();
    expect(config?.baseUrl).toBeUndefined();
    expect(config?.compat).toBeUndefined();
  });

  it('applies transport metadata to non-reasoning models', async () => {
    const config = await mapOne('anthropic/model');

    expect(config?.reasoning).toBe(false);
    expect(config?.api).toBe('anthropic-messages');
  });
});
