import type { OpenRouterModel, PiModelConfig, MapResult } from './types.js';

const COST_PER_MILLION = 1_000_000;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Maps a single OpenRouter model to Pi model config.
 * Returns null if the model should be skipped.
 */
export function mapOpenRouterModel(model: OpenRouterModel): PiModelConfig | null {
  // Skip: missing required id
  if (!model.id) {
    return null;
  }

  // Skip: missing required pricing fields
  if (!model.pricing?.prompt) {
    return null;
  }
  if (!model.pricing?.completion) {
    return null;
  }

  // Skip: missing context window (both primary and fallback)
  const contextWindow = model.top_provider?.context_length ?? model.context_length;
  if (!contextWindow) {
    return null;
  }

  // Skip: explicitly non-text output (if specified)
  const outputModalities = model.architecture?.output_modalities;
  if (outputModalities && !outputModalities.includes('text')) {
    return null;
  }

  // Determine reasoning support
  const supportedParams = model.supported_parameters ?? [];
  const hasReasoning =
    supportedParams.includes('reasoning') || supportedParams.includes('include_reasoning');

  // Determine input modalities
  const inputModalities = model.architecture?.input_modalities;
  const supportsImages = inputModalities?.includes('image') ?? false;

  // Build Pi model config
  return {
    id: model.id,
    name: model.name ?? model.id,
    reasoning: hasReasoning,
    input: supportsImages ? ['text', 'image'] : ['text'],
    cost: {
      input: Number(model.pricing.prompt) * COST_PER_MILLION,
      output: Number(model.pricing.completion) * COST_PER_MILLION,
      cacheRead: Number(model.pricing.input_cache_read ?? 0) * COST_PER_MILLION,
      cacheWrite: Number(model.pricing.input_cache_write ?? 0) * COST_PER_MILLION,
    },
    contextWindow,
    maxTokens:
      model.top_provider?.max_completion_tokens ??
      model.per_request_limits?.completion_tokens ??
      DEFAULT_MAX_TOKENS,
  };
}

/**
 * Maps multiple OpenRouter models, tracking skips.
 */
export function mapOpenRouterModels(models: OpenRouterModel[]): MapResult {
  const configs: PiModelConfig[] = [];
  let skipped = 0;

  for (const model of models) {
    const config = mapOpenRouterModel(model);
    if (config) {
      configs.push(config);
    } else {
      skipped++;
    }
  }

  return { configs, skipped };
}
