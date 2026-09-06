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

vi.mock('@earendil-works/pi-ai/providers/all', () => ({
  getBuiltinModels: vi.fn(() => [
    {
      id: 'test/model',
      thinkingLevelMap: {
        minimal: 'builtin-minimal',
        high: 'builtin-high',
        xhigh: 'builtin-xhigh',
        max: 'builtin-max',
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
            max: null,
          },
        },
      },
    });

    const result = await mapOpenRouterModels([
      createValidModel({
        id: 'test/model',
        supported_parameters: ['reasoning'],
        reasoning: {
          mandatory: false,
          supported_efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        },
      }),
    ]);

    expect(result.configs).toHaveLength(1);
    expect(result.configs[0]).toMatchObject({
      id: 'test/model',
      contextWindow: 64000,
      maxTokens: 8192,
      reasoning: false,
    });
    expect(result.configs[0]?.thinkingLevelMap).toEqual({
      minimal: 'builtin-minimal',
      high: 'override-high',
      xhigh: null,
      max: null,
    });
  });

  it('derives the exact GLM 5.3 effort map from API metadata', async () => {
    const result = await mapOpenRouterModels([
      createValidModel({
        id: 'z-ai/glm-5.3',
        reasoning: { mandatory: true, supported_efforts: ['low', 'high', 'max'] },
      }),
    ]);

    expect(result.configs[0]?.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max',
    });
  });

  it('derives an API map when an unrelated user override is present', async () => {
    loadModelOverrides.mockResolvedValue({
      version: 1,
      overrides: {
        'api/model': { contextWindow: 64000 },
      },
    });

    const result = await mapOpenRouterModels([
      createValidModel({
        id: 'api/model',
        reasoning: {
          mandatory: false,
          supported_efforts: ['low', null, 'future-effort', 'max', 'none'],
        },
      }),
    ]);

    expect(result.configs[0]).toMatchObject({
      reasoning: true,
      contextWindow: 64000,
      thinkingLevelMap: {
        off: 'none',
        minimal: null,
        low: 'low',
        medium: null,
        high: null,
        xhigh: null,
        max: 'max',
      },
    });
  });

  it.each([
    [true, null],
    [false, 'none'],
  ] as const)('maps mandatory=%s to off=%s for API maps', async (mandatory, off) => {
    const result = await mapOpenRouterModels([
      createValidModel({
        id: `api/mandatory-${mandatory}`,
        reasoning: { mandatory, supported_efforts: ['high'] },
      }),
    ]);

    expect(result.configs[0]?.thinkingLevelMap).toEqual({
      off,
      minimal: null,
      low: null,
      medium: null,
      high: 'high',
      xhigh: null,
      max: null,
    });
  });

  it.each([
    [true, null],
    [false, 'none'],
  ] as const)('maps explicit null supported_efforts with mandatory=%s', async (mandatory, off) => {
    const result = await mapOpenRouterModels([
      createValidModel({
        id: `api/unrestricted-${mandatory}`,
        reasoning: { mandatory, supported_efforts: null },
      }),
    ]);

    expect(result.configs[0]?.thinkingLevelMap).toEqual({
      off,
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    });
  });

  it('does not derive an API map from absent or unusable effort metadata', async () => {
    const cases: Array<Array<string | null> | undefined> = [
      undefined,
      [],
      [null],
      ['none'],
      ['future-effort'],
    ];

    for (const [index, supported_efforts] of cases.entries()) {
      const reasoning =
        supported_efforts === undefined
          ? { mandatory: false }
          : { mandatory: false, supported_efforts };
      const result = await mapOpenRouterModels([
        createValidModel({ id: `api/unusable-${index}`, reasoning }),
      ]);

      expect(result.configs[0]?.thinkingLevelMap).toBeUndefined();
    }
  });

  it('hides off for mandatory reasoning metadata with no usable effort', async () => {
    const result = await mapOpenRouterModels([
      createValidModel({
        id: 'api/mandatory-unknown-effort',
        reasoning: { mandatory: true, supported_efforts: [null, 'none', 'future-effort'] },
      }),
    ]);

    expect(result.configs[0]?.thinkingLevelMap).toEqual({ off: null });
  });

  it('does not derive an API map from supported_parameters alone', async () => {
    const result = await mapOpenRouterModels([
      createValidModel({
        id: 'api/parameter-only',
        supported_parameters: ['reasoning'],
      }),
    ]);

    expect(result.configs[0]?.reasoning).toBe(true);
    expect(result.configs[0]?.thinkingLevelMap).toBeUndefined();
  });

  it('merges sparse user thinkingLevelMap over the API map', async () => {
    loadModelOverrides.mockResolvedValue({
      version: 1,
      overrides: {
        'new/model': {
          thinkingLevelMap: {
            high: 'override-high',
            xhigh: 'max',
          },
        },
      },
    });

    const result = await mapOpenRouterModels([
      createValidModel({
        id: 'new/model',
        supported_parameters: ['reasoning'],
        reasoning: { mandatory: true, supported_efforts: ['low', 'high', 'max'] },
      }),
    ]);

    expect(result.configs).toHaveLength(1);
    expect(result.configs[0]).toMatchObject({
      id: 'new/model',
      reasoning: true,
    });
    expect(result.configs[0]?.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: 'low',
      medium: null,
      high: 'override-high',
      xhigh: 'max',
      max: 'max',
    });
  });
});
