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

vi.mock('@earendil-works/pi-ai', () => ({
  getModels: vi.fn(() => [
    {
      id: 'test/model',
      thinkingLevelMap: {
        minimal: 'builtin-minimal',
        high: 'builtin-high',
        xhigh: 'builtin-xhigh',
      },
    },
  ]),
}));

import { mapOpenRouterModels } from '../mapper.js';

describe('mapOpenRouterModels overrides', () => {
  beforeEach(() => {
    loadModelOverrides.mockResolvedValue({ version: 1, overrides: {} });
  });

  it('applies top-level overrides and merges sparse thinkingLevelMap with built-in values', async () => {
    loadModelOverrides.mockResolvedValue({
      version: 1,
      overrides: {
        'test/model': {
          contextWindow: 64000,
          maxTokens: 8192,
          reasoning: false,
          thinkingLevelMap: {
            high: 'override-high',
            xhigh: null,
          },
        },
      },
    });

    const result = await mapOpenRouterModels([
      createValidModel({
        id: 'test/model',
        supported_parameters: ['reasoning'],
      }),
    ]);

    expect(result.configs).toHaveLength(1);
    expect(result.configs[0]).toMatchObject({
      id: 'test/model',
      contextWindow: 64000,
      maxTokens: 8192,
      reasoning: false,
      thinkingLevelMap: {
        minimal: 'builtin-minimal',
        high: 'override-high',
        xhigh: null,
      },
    });
  });

  it('applies user thinkingLevelMap when the built-in registry has no map for the model', async () => {
    loadModelOverrides.mockResolvedValue({
      version: 1,
      overrides: {
        'new/model': {
          thinkingLevelMap: {
            high: 'high',
            xhigh: 'max',
          },
        },
      },
    });

    const result = await mapOpenRouterModels([
      createValidModel({
        id: 'new/model',
        supported_parameters: ['reasoning'],
      }),
    ]);

    expect(result.configs).toHaveLength(1);
    expect(result.configs[0]).toMatchObject({
      id: 'new/model',
      reasoning: true,
      thinkingLevelMap: {
        high: 'high',
        xhigh: 'max',
      },
    });
  });
});
