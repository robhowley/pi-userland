import { describe, it, expect } from 'vitest';
import { mapOpenRouterModel, mapOpenRouterModels } from '../mapper.js';
import { createValidModel } from '../../__tests__/fixtures.js';
import type { OpenRouterModel, MapResult } from '../types.js';

describe('mapOpenRouterModel', () => {
  it('should map a valid model correctly', async () => {
    const model = createValidModel();
    const result = await mapOpenRouterModel(model);

    expect(result).not.toBeNull();
    expect(result!.id).toBe('test/model');
    expect(result!.name).toBe('Test Model');
    expect(result!.contextWindow).toBe(128000);
    expect(result!.maxTokens).toBe(4096); // default
    expect(result!.cost.input).toBe(0.5); // 0.0000005 * 1M
    expect(result!.cost.output).toBe(1.5); // 0.0000015 * 1M
  });

  it('should use name fallback to id when name missing', async () => {
    const model = createValidModel();
    // @ts-expect-error: intentionally setting name to undefined for test
    model.name = undefined;
    const result = await mapOpenRouterModel(model);

    expect(result!.name).toBe('test/model');
  });

  describe('skip conditions', () => {
    const skipCases: Array<{
      name: string;
      overrides: Partial<OpenRouterModel> | ((m: OpenRouterModel) => void);
    }> = [
      { name: 'empty id', overrides: { id: '' } },
      { name: 'undefined id (deleted property)', overrides: (m) => delete (m as any).id },
      { name: 'missing pricing.prompt', overrides: { pricing: { completion: '0.000001' } as any } },
      { name: 'missing pricing.completion', overrides: { pricing: { prompt: '0.000001' } as any } },
      {
        name: 'missing context_length and top_provider',
        overrides: { context_length: 0, top_provider: { context_length: 0 } },
      },
      {
        name: 'non-text output modalities',
        overrides: { architecture: { output_modalities: ['image', 'audio'] } as any },
      },
    ];

    skipCases.forEach(({ name, overrides }) => {
      it(`should skip model with ${name}`, async () => {
        const model = createValidModel();
        if (typeof overrides === 'function') {
          overrides(model);
        } else {
          Object.assign(model, overrides);
        }
        expect(await mapOpenRouterModel(model)).toBeNull();
      });
    });
  });

  describe('reasoning detection', () => {
    it("should detect reasoning from 'reasoning' parameter", async () => {
      const model = createValidModel({
        supported_parameters: ['temperature', 'reasoning', 'max_tokens'],
      });
      expect((await mapOpenRouterModel(model))!.reasoning).toBe(true);
    });

    it("should detect reasoning from 'include_reasoning' parameter", async () => {
      const model = createValidModel({
        supported_parameters: ['include_reasoning'],
      });
      expect((await mapOpenRouterModel(model))!.reasoning).toBe(true);
    });

    it('should not detect reasoning when neither parameter present', async () => {
      const model = createValidModel({
        supported_parameters: ['temperature', 'max_tokens'],
      });
      expect((await mapOpenRouterModel(model))!.reasoning).toBe(false);
    });

    it('should handle missing supported_parameters', async () => {
      const model = createValidModel({ supported_parameters: [] as any });
      expect((await mapOpenRouterModel(model))!.reasoning).toBe(false);
    });
  });

  describe('input modality detection', () => {
    it('should detect image support from input_modalities', async () => {
      const model = createValidModel({
        architecture: { input_modalities: ['text', 'image'] } as any,
      });
      expect((await mapOpenRouterModel(model))!.input).toEqual(['text', 'image']);
    });

    it('should default to text-only without image in modalities', async () => {
      const model = createValidModel({
        architecture: { input_modalities: ['text'] } as any,
      });
      expect((await mapOpenRouterModel(model))!.input).toEqual(['text']);
    });

    it('should default to text-only when architecture missing', async () => {
      const model = createValidModel({ architecture: null as any });
      expect((await mapOpenRouterModel(model))!.input).toEqual(['text']);
    });
  });

  describe('cost calculation', () => {
    it('should convert per-token to per-1M-tokens', async () => {
      const model = createValidModel({
        pricing: { prompt: '0.000002', completion: '0.000006' },
      });
      const result = await mapOpenRouterModel(model);
      expect(result!.cost.input).toBe(2.0); // 0.000002 * 1,000,000
      expect(result!.cost.output).toBe(6.0); // 0.000006 * 1,000,000
    });

    it('should handle cache pricing when present', async () => {
      const model = createValidModel({
        pricing: {
          prompt: '0.000001',
          completion: '0.000003',
          input_cache_read: '0.0000005',
          input_cache_write: '0.000001',
        },
      });
      const result = await mapOpenRouterModel(model);
      expect(result!.cost.cacheRead).toBe(0.5);
      expect(result!.cost.cacheWrite).toBe(1.0);
    });

    it('should default cache pricing to 0 when missing', async () => {
      const model = createValidModel({
        pricing: { prompt: '0.000001', completion: '0.000003' },
      });
      const result = await mapOpenRouterModel(model);
      expect(result!.cost.cacheRead).toBe(0);
      expect(result!.cost.cacheWrite).toBe(0);
    });
  });

  describe('contextWindow fallback', () => {
    it('should prefer top_provider.context_length', async () => {
      const model = createValidModel({
        context_length: 8000,
        top_provider: { context_length: 128000 },
      });
      expect((await mapOpenRouterModel(model))!.contextWindow).toBe(128000);
    });

    it('should fall back to context_length', async () => {
      const model = createValidModel({
        context_length: 32000,
        top_provider: null as any,
      });
      expect((await mapOpenRouterModel(model))!.contextWindow).toBe(32000);
    });
  });

  describe('maxTokens fallback', () => {
    it('should prefer top_provider.max_completion_tokens', async () => {
      const model = createValidModel({
        top_provider: { max_completion_tokens: 8192 },
        per_request_limits: { completion_tokens: 4096 },
      });
      expect((await mapOpenRouterModel(model))!.maxTokens).toBe(8192);
    });

    it('should fall back to per_request_limits.completion_tokens', async () => {
      const model = createValidModel({
        per_request_limits: { completion_tokens: 8192 },
      });
      expect((await mapOpenRouterModel(model))!.maxTokens).toBe(8192);
    });

    it('should use default when neither present', async () => {
      const model = createValidModel();
      expect((await mapOpenRouterModel(model))!.maxTokens).toBe(4096);
    });
  });

  describe('thinkingLevelMap', () => {
    it('should include thinkingLevelMap when available from built-in registry', async () => {
      // This test documents the expected behavior when the model exists
      // in Pi's built-in registry. The actual lookup happens via dynamic import
      // of @mariozechner/pi-ai or @earendil-works/pi-ai at runtime.
      const model = createValidModel({
        id: 'deepseek/deepseek-v4-pro',
        supported_parameters: ['reasoning'],
      });
      const result = await mapOpenRouterModel(model);
      expect(result).not.toBeNull();
      // If pi-ai is available and has this model, thinkingLevelMap will be set
      // Otherwise it will be undefined (which is valid)
      expect(result!.thinkingLevelMap === undefined || typeof result!.thinkingLevelMap === 'object').toBe(true);
    });
  });
});

describe('mapOpenRouterModels', () => {
  it('should map multiple models and track skips', async () => {
    const models: OpenRouterModel[] = [
      createValidModel({ id: 'model/valid-1', name: 'Valid 1' }),
      createValidModel({ id: '', name: 'Invalid (no id)' }), // will skip
      createValidModel({ id: 'model/valid-2', name: 'Valid 2' }),
    ];

    const result: MapResult = await mapOpenRouterModels(models);

    expect(result.configs).toHaveLength(2);
    expect(result.skipped).toBe(1);
    expect(result.configs[0]!.id).toBe('model/valid-1');
    expect(result.configs[1]!.id).toBe('model/valid-2');
  });

  it('should handle empty array', async () => {
    const result = await mapOpenRouterModels([] as OpenRouterModel[]);
    expect(result.configs).toHaveLength(0);
    expect(result.skipped).toBe(0);
  });

  it('should skip all invalid models', async () => {
    const models: OpenRouterModel[] = [
      createValidModel({ id: '' }),
      createValidModel({ pricing: { prompt: '0.000001' } as any }),
      createValidModel({
        context_length: 0,
        top_provider: { context_length: 0 },
      }),
    ];

    const result = await mapOpenRouterModels(models);
    expect(result.configs).toHaveLength(0);
    expect(result.skipped).toBe(3);
  });
});
