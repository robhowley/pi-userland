import type { OpenRouterModel, PiModelConfig, SkipReason, MapResult } from './types.js';
import { ROUTER_ALIASES } from './types.js';
import type { Model as SDKModel } from '@openrouter/sdk/models/index.js';

const COST_PER_MILLION = 1_000_000;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Convert SDK Model to our OpenRouterModel type for compatibility.
 * Handles SDK's camelCase naming convention.
 */
export function sdkModelToOpenRouterModel(model: SDKModel): OpenRouterModel {
  const topProvider = model.topProvider
    ? {
        context_length: model.topProvider.contextLength ?? 0,
        max_completion_tokens: model.topProvider.maxCompletionTokens ?? 0,
      }
    : undefined;

  const perRequestLimits = model.perRequestLimits
    ? {
        completion_tokens: model.perRequestLimits.completionTokens ?? 0,
      }
    : undefined;

  // Build the object conditionally to avoid undefined property issues
  const result: OpenRouterModel = {
    id: model.id,
    name: model.name,
    architecture: {
      input_modalities: model.architecture.inputModalities ?? [],
      output_modalities: model.architecture.outputModalities ?? [],
    },
    context_length: model.contextLength ?? 0,
    pricing: {
      prompt: String(model.pricing.prompt ?? 0),
      completion: String(model.pricing.completion ?? 0),
      input_cache_read: String(model.pricing.inputCacheRead ?? 0),
      input_cache_write: String(model.pricing.inputCacheWrite ?? 0),
    },
    supported_parameters: model.supportedParameters,
  };

  // Conditionally add optional properties to avoid explicit undefined
  if (topProvider) {
    result.top_provider = topProvider;
  }
  if (perRequestLimits) {
    result.per_request_limits = perRequestLimits;
  }

  return result;
}

/**
 * Normalize input model to OpenRouterModel format.
 */
function normalizeModel(model: OpenRouterModel | SDKModel): OpenRouterModel {
  return 'contextLength' in model
    ? sdkModelToOpenRouterModel(model as SDKModel)
    : (model as OpenRouterModel);
}

/**
 * Validation result for a model check.
 */
type ValidationResult =
  | { valid: true; model: OpenRouterModel; contextWindow: number }
  | { valid: false; reason: string; modelId: string };

/**
 * Validate a model and return either a valid result with extracted context window
 * or a failure reason.
 */
function validateModel(model: OpenRouterModel): ValidationResult {
  // Check: missing required id
  if (!model.id) {
    return { valid: false, reason: 'missing id', modelId: 'unknown' };
  }

  // Check: missing required pricing fields
  if (!model.pricing?.prompt) {
    return { valid: false, reason: 'missing prompt pricing', modelId: model.id };
  }
  if (!model.pricing?.completion) {
    return { valid: false, reason: 'missing completion pricing', modelId: model.id };
  }

  // Check: missing context window (both primary and fallback)
  const contextWindow = model.top_provider?.context_length ?? model.context_length;
  if (!contextWindow) {
    return { valid: false, reason: 'missing context window', modelId: model.id };
  }

  // Check: explicitly non-text output (if specified)
  const outputModalities = model.architecture?.output_modalities;
  if (outputModalities && !outputModalities.includes('text')) {
    return { valid: false, reason: 'non-text output modalities', modelId: model.id };
  }

  return { valid: true, model, contextWindow };
}

/**
 * Build PiModelConfig from a validated OpenRouterModel.
 */
function buildPiConfig(model: OpenRouterModel, contextWindow: number): PiModelConfig {
  const supportedParams = model.supported_parameters ?? [];
  const hasReasoning =
    supportedParams.includes('reasoning') || supportedParams.includes('include_reasoning');
  const inputModalities = model.architecture?.input_modalities;
  const supportsImages = inputModalities?.includes('image') ?? false;

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
export function mapOpenRouterModels(models: OpenRouterModel[] | SDKModel[]): MapResult {
  const configs: PiModelConfig[] = [];
  let skipped = 0;
  const skippedDetails: SkipReason[] = [];

  for (const rawModel of models) {
    const model = normalizeModel(rawModel);

    // Skip router aliases - they're added manually after mapping
    if (ROUTER_ALIASES.includes(model.id)) {
      continue;
    }

    const validation = validateModel(model);

    if (!validation.valid) {
      skipped++;
      skippedDetails.push({ id: validation.modelId, reason: validation.reason });
      continue;
    }

    configs.push(buildPiConfig(model, validation.contextWindow));
  }

  return { configs, skipped, skippedDetails };
}

/**
 * Maps a single OpenRouter model to Pi model config.
 * Returns null if the model should be skipped.
 */
export function mapOpenRouterModel(model: OpenRouterModel | SDKModel): PiModelConfig | null {
  const normalized = normalizeModel(model);

  // Router aliases are handled separately, skip them here
  if (ROUTER_ALIASES.includes(normalized.id)) {
    return null;
  }

  const validation = validateModel(normalized);

  if (!validation.valid) {
    return null;
  }

  return buildPiConfig(normalized, validation.contextWindow);
}
