import { describe, it, expect } from 'vitest';
import { mapOpenRouterModel, mapOpenRouterModels } from '../mapper.js';
import type { OpenRouterModel, MapResult } from '../types.js';

// Helper to create a valid base model
function createValidModel(overrides?: Partial<OpenRouterModel>): OpenRouterModel {
  return {
    id: 'test/model',
    name: 'Test Model',
    context_length: 128000,
    pricing: {
      prompt: '0.0000005',
      completion: '0.0000015',
    },
    ...overrides,
  };
}

describe('mapOpenRouterModel', () => {
  it('should map a valid model correctly', () => {
    const model = createValidModel();
    const result = mapOpenRouterModel(model);

    expect(result).not.toBeNull();
    expect(result!.id).toBe('test/model');
    expect(result!.name).toBe('Test Model');
    expect(result!.contextWindow).toBe(128000);
    expect(result!.maxTokens).toBe(4096); // default
    expect(result!.cost.input).toBe(0.5); // 0.0000005 * 1M
    expect(result!.cost.output).toBe(1.5); // 0.0000015 * 1M
  });

  it('should use name fallback to id when name missing', () => {
    const model = createValidModel();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (model as any).name = undefined;
    const result = mapOpenRouterModel(model);

    expect(result!.name).toBe('test/model');
  });

  describe('skip conditions', () => {
    it('should skip model with missing id', () => {
      const model = createValidModel({ id: '' });
      expect(mapOpenRouterModel(model)).toBeNull();
    });

    it('should skip model with undefined id', () => {
      const model = createValidModel();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (model as any).id;
      expect(mapOpenRouterModel(model)).toBeNull();
    });

    it('should skip model with missing pricing.prompt', () => {
      const model = createValidModel({
        pricing: { completion: '0.000001' } as any,
      });
      expect(mapOpenRouterModel(model)).toBeNull();
    });

    it('should skip model with missing pricing.completion', () => {
      const model = createValidModel({
        pricing: { prompt: '0.000001' } as any,
      });
      expect(mapOpenRouterModel(model)).toBeNull();
    });

    it('should skip model with missing context_length and top_provider', () => {
      const model = createValidModel({
        context_length: 0,
        top_provider: { context_length: 0 },
      });
      expect(mapOpenRouterModel(model)).toBeNull();
    });

    it('should skip model with non-text output modalities', () => {
      const model = createValidModel({
        architecture: { output_modalities: ['image', 'audio'] } as any,
      });
      expect(mapOpenRouterModel(model)).toBeNull();
    });
  });

  describe('reasoning detection', () => {
    it("should detect reasoning from 'reasoning' parameter", () => {
      const model = createValidModel({
        supported_parameters: ['temperature', 'reasoning', 'max_tokens'],
      });
      expect(mapOpenRouterModel(model)!.reasoning).toBe(true);
    });

    it("should detect reasoning from 'include_reasoning' parameter", () => {
      const model = createValidModel({
        supported_parameters: ['include_reasoning'],
      });
      expect(mapOpenRouterModel(model)!.reasoning).toBe(true);
    });

    it('should not detect reasoning when neither parameter present', () => {
      const model = createValidModel({
        supported_parameters: ['temperature', 'max_tokens'],
      });
      expect(mapOpenRouterModel(model)!.reasoning).toBe(false);
    });

    it('should handle missing supported_parameters', () => {
      const model = createValidModel({ supported_parameters: [] as any });
      expect(mapOpenRouterModel(model)!.reasoning).toBe(false);
    });
  });

  describe('input modality detection', () => {
    it('should detect image support from input_modalities', () => {
      const model = createValidModel({
        architecture: { input_modalities: ['text', 'image'] } as any,
      });
      expect(mapOpenRouterModel(model)!.input).toEqual(['text', 'image']);
    });

    it('should default to text-only without image in modalities', () => {
      const model = createValidModel({
        architecture: { input_modalities: ['text'] } as any,
      });
      expect(mapOpenRouterModel(model)!.input).toEqual(['text']);
    });

    it('should default to text-only when architecture missing', () => {
      const model = createValidModel({ architecture: null as any });
      expect(mapOpenRouterModel(model)!.input).toEqual(['text']);
    });
  });

  describe('cost calculation', () => {
    it('should convert per-token to per-1M-tokens', () => {
      const model = createValidModel({
        pricing: { prompt: '0.000002', completion: '0.000006' },
      });
      const result = mapOpenRouterModel(model);
      expect(result!.cost.input).toBe(2.0); // 0.000002 * 1,000,000
      expect(result!.cost.output).toBe(6.0); // 0.000006 * 1,000,000
    });

    it('should handle cache pricing when present', () => {
      const model = createValidModel({
        pricing: {
          prompt: '0.000001',
          completion: '0.000003',
          input_cache_read: '0.0000005',
          input_cache_write: '0.000001',
        },
      });
      const result = mapOpenRouterModel(model);
      expect(result!.cost.cacheRead).toBe(0.5);
      expect(result!.cost.cacheWrite).toBe(1.0);
    });

    it('should default cache pricing to 0 when missing', () => {
      const model = createValidModel({
        pricing: { prompt: '0.000001', completion: '0.000003' },
      });
      const result = mapOpenRouterModel(model);
      expect(result!.cost.cacheRead).toBe(0);
      expect(result!.cost.cacheWrite).toBe(0);
    });
  });

  describe('contextWindow fallback', () => {
    it('should prefer top_provider.context_length', () => {
      const model = createValidModel({
        context_length: 8000,
        top_provider: { context_length: 128000 },
      });
      expect(mapOpenRouterModel(model)!.contextWindow).toBe(128000);
    });

    it('should fall back to context_length', () => {
      const model = createValidModel({
        context_length: 32000,
        top_provider: null as any,
      });
      expect(mapOpenRouterModel(model)!.contextWindow).toBe(32000);
    });
  });

  describe('maxTokens fallback', () => {
    it('should prefer top_provider.max_completion_tokens', () => {
      const model = createValidModel({
        top_provider: { max_completion_tokens: 8192 },
        per_request_limits: { completion_tokens: 4096 },
      });
      expect(mapOpenRouterModel(model)!.maxTokens).toBe(8192);
    });

    it('should fall back to per_request_limits.completion_tokens', () => {
      const model = createValidModel({
        per_request_limits: { completion_tokens: 8192 },
      });
      expect(mapOpenRouterModel(model)!.maxTokens).toBe(8192);
    });

    it('should use default when neither present', () => {
      const model = createValidModel();
      expect(mapOpenRouterModel(model)!.maxTokens).toBe(4096);
    });
  });
});

describe('mapOpenRouterModels', () => {
  it('should map multiple models and track skips', () => {
    const models: OpenRouterModel[] = [
      createValidModel({ id: 'model/valid-1', name: 'Valid 1' }),
      createValidModel({ id: '', name: 'Invalid (no id)' }), // will skip
      createValidModel({ id: 'model/valid-2', name: 'Valid 2' }),
    ];

    const result: MapResult = mapOpenRouterModels(models);

    expect(result.configs).toHaveLength(2);
    expect(result.skipped).toBe(1);
    expect(result.configs[0]!.id).toBe('model/valid-1');
    expect(result.configs[1]!.id).toBe('model/valid-2');
  });

  it('should handle empty array', () => {
    const result = mapOpenRouterModels([] as OpenRouterModel[]);
    expect(result.configs).toHaveLength(0);
    expect(result.skipped).toBe(0);
  });

  it('should skip all invalid models', () => {
    const models: OpenRouterModel[] = [
      createValidModel({ id: '' }),
      createValidModel({ pricing: { prompt: '0.000001' } as any }),
      createValidModel({
        context_length: 0,
        top_provider: { context_length: 0 },
      }),
    ];

    const result = mapOpenRouterModels(models);
    expect(result.configs).toHaveLength(0);
    expect(result.skipped).toBe(3);
  });
});
