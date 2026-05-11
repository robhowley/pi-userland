import type { OpenRouterModel, PiModelConfig, SkipReason } from './types.js';
import type { Model as SDKModel } from '@openrouter/sdk/models/index.js';

const COST_PER_MILLION = 1_000_000;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Convert SDK Model to our OpenRouterModel type for compatibility.
 * Handles SDK's camelCase naming convention.
 */
function sdkModelToOpenRouterModel(model: SDKModel): OpenRouterModel {
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
 * Mapping result with skip reason tracking
 */
export interface MapResult {
  configs: PiModelConfig[];
  skipped: number;
  skippedDetails: SkipReason[];
}

/**
 * Maps a single OpenRouter model to Pi model config.
 * Returns null if the model should be skipped.
 */
export function mapOpenRouterModel(model: OpenRouterModel | SDKModel): PiModelConfig | null {
  // Convert SDK model if needed
  const openRouterModel: OpenRouterModel =
    'contextLength' in model
      ? sdkModelToOpenRouterModel(model as SDKModel)
      : (model as OpenRouterModel);

  // Skip: missing required id
  if (!openRouterModel.id) {
    return null;
  }

  // Skip: missing required pricing fields
  if (!openRouterModel.pricing?.prompt) {
    return null;
  }
  if (!openRouterModel.pricing?.completion) {
    return null;
  }

  // Skip: missing context window (both primary and fallback)
  const contextWindow =
    openRouterModel.top_provider?.context_length ?? openRouterModel.context_length;
  if (!contextWindow) {
    return null;
  }

  // Skip: explicitly non-text output (if specified)
  const outputModalities = openRouterModel.architecture?.output_modalities;
  if (outputModalities && !outputModalities.includes('text')) {
    return null;
  }

  // Determine reasoning support
  const supportedParams = openRouterModel.supported_parameters ?? [];
  const hasReasoning =
    supportedParams.includes('reasoning') || supportedParams.includes('include_reasoning');

  // Determine input modalities
  const inputModalities = openRouterModel.architecture?.input_modalities;
  const supportsImages = inputModalities?.includes('image') ?? false;

  // Build Pi model config
  return {
    id: openRouterModel.id,
    name: openRouterModel.name ?? openRouterModel.id,
    reasoning: hasReasoning,
    input: supportsImages ? ['text', 'image'] : ['text'],
    cost: {
      input: Number(openRouterModel.pricing.prompt) * COST_PER_MILLION,
      output: Number(openRouterModel.pricing.completion) * COST_PER_MILLION,
      cacheRead: Number(openRouterModel.pricing.input_cache_read ?? 0) * COST_PER_MILLION,
      cacheWrite: Number(openRouterModel.pricing.input_cache_write ?? 0) * COST_PER_MILLION,
    },
    contextWindow,
    maxTokens:
      openRouterModel.top_provider?.max_completion_tokens ??
      openRouterModel.per_request_limits?.completion_tokens ??
      DEFAULT_MAX_TOKENS,
  };
}

/**
 * Builtin router aliases that should always be available.
 */
const ROUTER_ALIASES = ['openrouter/auto', 'openrouter/free', 'openrouter/owl-alpha'];

/**
 * Maps multiple OpenRouter models, tracking skips.
 */
export function mapOpenRouterModels(models: OpenRouterModel[] | SDKModel[]): MapResult {
  const configs: PiModelConfig[] = [];
  let skipped = 0;
  const skippedDetails: SkipReason[] = [];

  for (const model of models) {
    const openRouterModel: OpenRouterModel =
      'contextLength' in model
        ? sdkModelToOpenRouterModel(model as SDKModel)
        : (model as OpenRouterModel);

    // Skip router aliases - they're added manually after mapping
    if (ROUTER_ALIASES.includes(openRouterModel.id)) {
      continue;
    }

    // Check skip conditions with detailed reasons
    if (!openRouterModel.id) {
      skipped++;
      skippedDetails.push({ id: 'unknown', reason: 'missing id' });
      continue;
    }

    if (!openRouterModel.pricing?.prompt) {
      skipped++;
      skippedDetails.push({ id: openRouterModel.id, reason: 'missing prompt pricing' });
      continue;
    }

    if (!openRouterModel.pricing?.completion) {
      skipped++;
      skippedDetails.push({ id: openRouterModel.id, reason: 'missing completion pricing' });
      continue;
    }

    const contextWindow =
      openRouterModel.top_provider?.context_length ?? openRouterModel.context_length;
    if (!contextWindow) {
      skipped++;
      skippedDetails.push({ id: openRouterModel.id, reason: 'missing context window' });
      continue;
    }

    const outputModalities = openRouterModel.architecture?.output_modalities;
    if (outputModalities && !outputModalities.includes('text')) {
      skipped++;
      skippedDetails.push({ id: openRouterModel.id, reason: 'non-text output modalities' });
      continue;
    }

    // Model passed all checks, build config
    const supportedParams = openRouterModel.supported_parameters ?? [];
    const hasReasoning =
      supportedParams.includes('reasoning') || supportedParams.includes('include_reasoning');
    const inputModalities = openRouterModel.architecture?.input_modalities;
    const supportsImages = inputModalities?.includes('image') ?? false;

    configs.push({
      id: openRouterModel.id,
      name: openRouterModel.name ?? openRouterModel.id,
      reasoning: hasReasoning,
      input: supportsImages ? ['text', 'image'] : ['text'],
      cost: {
        input: Number(openRouterModel.pricing.prompt) * COST_PER_MILLION,
        output: Number(openRouterModel.pricing.completion) * COST_PER_MILLION,
        cacheRead: Number(openRouterModel.pricing.input_cache_read ?? 0) * COST_PER_MILLION,
        cacheWrite: Number(openRouterModel.pricing.input_cache_write ?? 0) * COST_PER_MILLION,
      },
      contextWindow,
      maxTokens:
        openRouterModel.top_provider?.max_completion_tokens ??
        openRouterModel.per_request_limits?.completion_tokens ??
        DEFAULT_MAX_TOKENS,
    });
  }

  return { configs, skipped, skippedDetails };
}
