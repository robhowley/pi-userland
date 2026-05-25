import type { OpenRouterModel, PiModelConfig, SkipReason, MapResult } from './types.js';
import { ROUTER_ALIASES } from './types.js';
import { getSkipReasonHint } from './skip-hints.js';
import type { Model as SDKModel } from '@openrouter/sdk/models/index.js';
import { loadModelOverrides, getModelOverride } from './overrides.js';
import { normalizeOpenRouterModel } from '../normalizers.js';

// Cache for built-in OpenRouter models from pi-ai
// Populated lazily on first access
let builtInOpenRouterModels: Map<string, PiModelConfig> | undefined;

/**
 * Load built-in OpenRouter models from pi-ai package if available.
 * This allows us to preserve thinkingLevelMap and other metadata from
 * Pi's built-in registry when syncing models from OpenRouter API.
 */
async function loadBuiltInOpenRouterModels(): Promise<Map<string, PiModelConfig>> {
  if (builtInOpenRouterModels !== undefined) {
    return builtInOpenRouterModels;
  }

  const models = new Map<string, PiModelConfig>();

  try {
    // Import from pi-ai to get built-in model registry
    const { getModels } = (await import('@earendil-works/pi-ai')) as {
      getModels: (provider: string) => unknown[];
    };

    const openrouterModels = getModels('openrouter');
    if (Array.isArray(openrouterModels)) {
      for (const model of openrouterModels) {
        // Extract thinkingLevelMap from built-in model if present
        const modelWithThinking = model as { id: string; thinkingLevelMap?: unknown };
        if (modelWithThinking.id) {
          models.set(modelWithThinking.id, model as PiModelConfig);
        }
      }
    }
  } catch {
    // Ignore - built-in registry not available, will sync without merging
  }

  builtInOpenRouterModels = models;
  return models;
}

/**
 * Get thinkingLevelMap from built-in registry for a model, if available.
 */
async function getBuiltInThinkingLevelMap(
  modelId: string,
): Promise<PiModelConfig['thinkingLevelMap'] | undefined> {
  const builtIn = await loadBuiltInOpenRouterModels();
  return builtIn.get(modelId)?.thinkingLevelMap;
}

const COST_PER_MILLION = 1_000_000;
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Validation result for a model check.
 */
type ValidationResult =
  | { valid: true; model: OpenRouterModel; contextWindow: number }
  | { valid: false; reason: string; modelId: string; hint?: string };

/**
 * Build a failed validation result with a stable machine reason and optional hint.
 */
function invalidModel(reason: string, modelId: string): ValidationResult {
  const hint = getSkipReasonHint(reason);
  return hint ? { valid: false, reason, modelId, hint } : { valid: false, reason, modelId };
}

/**
 * Validate a model and return either a valid result with extracted context window
 * or a failure reason.
 */
function validateModel(model: OpenRouterModel): ValidationResult {
  // Check: missing required id
  if (!model.id) {
    return invalidModel('missing id', 'unknown');
  }

  // Check: missing required pricing fields
  if (!model.pricing?.prompt) {
    return invalidModel('missing prompt pricing', model.id);
  }
  if (!model.pricing?.completion) {
    return invalidModel('missing completion pricing', model.id);
  }

  // Check: missing context window (both primary and fallback)
  const contextWindow = model.top_provider?.context_length ?? model.context_length;
  if (!contextWindow) {
    return invalidModel('missing context window', model.id);
  }

  // Check: explicitly non-text output (if specified)
  const outputModalities = model.architecture?.output_modalities;
  if (outputModalities && !outputModalities.includes('text')) {
    return invalidModel('non-text output modalities', model.id);
  }

  return { valid: true, model, contextWindow };
}

/**
 * Build PiModelConfig from a validated OpenRouterModel.
 * Merges thinkingLevelMap from Pi's built-in registry and user overrides.
 * Priority: user overrides > built-in registry > API data
 */
async function buildPiConfig(
  model: OpenRouterModel,
  contextWindow: number,
  userOverrides?: Awaited<ReturnType<typeof loadModelOverrides>>,
): Promise<PiModelConfig> {
  const supportedParams = model.supported_parameters ?? [];
  const hasReasoning =
    supportedParams.includes('reasoning') || supportedParams.includes('include_reasoning');
  const inputModalities = model.architecture?.input_modalities;
  const supportsImages = inputModalities?.includes('image') ?? false;

  // Fetch thinkingLevelMap from built-in registry if this is a reasoning model
  const builtInThinkingLevelMap = hasReasoning
    ? await getBuiltInThinkingLevelMap(model.id)
    : undefined;

  // Fetch user override for this model
  const userOverride = userOverrides ? getModelOverride(userOverrides, model.id) : undefined;

  const thinkingLevelMap =
    builtInThinkingLevelMap !== undefined || userOverride?.thinkingLevelMap !== undefined
      ? {
          ...builtInThinkingLevelMap,
          ...userOverride?.thinkingLevelMap,
        }
      : undefined;

  const config: PiModelConfig = {
    id: model.id,
    name: model.name ?? model.id,
    reasoning: userOverride?.reasoning ?? hasReasoning,
    input: supportsImages ? ['text', 'image'] : ['text'],
    cost: {
      input: Number(model.pricing.prompt) * COST_PER_MILLION,
      output: Number(model.pricing.completion) * COST_PER_MILLION,
      cacheRead: Number(model.pricing.input_cache_read ?? 0) * COST_PER_MILLION,
      cacheWrite: Number(model.pricing.input_cache_write ?? 0) * COST_PER_MILLION,
    },
    contextWindow: userOverride?.contextWindow ?? contextWindow,
    maxTokens:
      userOverride?.maxTokens ??
      model.top_provider?.max_completion_tokens ??
      model.per_request_limits?.completion_tokens ??
      DEFAULT_MAX_TOKENS,
  };

  // Only add thinkingLevelMap if it's defined for exactOptionalPropertyTypes compatibility
  if (thinkingLevelMap !== undefined) {
    config.thinkingLevelMap = thinkingLevelMap;
  }

  return config;
}

/**
 * Maps multiple OpenRouter models, tracking skips.
 * Async to allow fetching thinkingLevelMap from built-in registry and user overrides.
 */
export async function mapOpenRouterModels(
  models: OpenRouterModel[] | SDKModel[],
): Promise<MapResult> {
  // Pre-load built-in models and user overrides for efficient lookup during mapping
  await loadBuiltInOpenRouterModels();
  const userOverrides = await loadModelOverrides();

  const configs: PiModelConfig[] = [];
  let skipped = 0;
  const skippedDetails: SkipReason[] = [];

  for (const rawModel of models) {
    const model = normalizeOpenRouterModel(rawModel);

    // Skip router aliases - they're added manually after mapping
    if (ROUTER_ALIASES.includes(model.id)) {
      continue;
    }

    const validation = validateModel(model);

    if (!validation.valid) {
      skipped++;
      const skippedDetail: SkipReason = {
        id: validation.modelId,
        reason: validation.reason,
      };
      if (validation.hint) {
        skippedDetail.hint = validation.hint;
      }
      skippedDetails.push(skippedDetail);
      continue;
    }

    configs.push(await buildPiConfig(model, validation.contextWindow, userOverrides));
  }

  return { configs, skipped, skippedDetails };
}

/**
 * Maps a single OpenRouter model to Pi model config.
 * Returns null if the model should be skipped.
 * Async to allow fetching thinkingLevelMap from built-in registry.
 */
export async function mapOpenRouterModel(
  model: OpenRouterModel | SDKModel,
): Promise<PiModelConfig | null> {
  await loadBuiltInOpenRouterModels();
  const userOverrides = await loadModelOverrides();

  const normalized = normalizeOpenRouterModel(model);

  // Router aliases are handled separately, skip them here
  if (ROUTER_ALIASES.includes(normalized.id)) {
    return null;
  }

  const validation = validateModel(normalized);

  if (!validation.valid) {
    return null;
  }

  return buildPiConfig(normalized, validation.contextWindow, userOverrides);
}
