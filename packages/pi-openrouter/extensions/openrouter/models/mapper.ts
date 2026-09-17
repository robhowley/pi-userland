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
    const { getBuiltinModels } = await import('@earendil-works/pi-ai/providers/all');

    const openrouterModels = getBuiltinModels('openrouter');
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

/**
 * Transport metadata owned by Pi's built-in registry that the OpenRouter API does not
 * describe: the `api`, its matching `baseUrl`, and the `compat` flags authored for it.
 */
interface BuiltInTransport {
  api?: PiModelConfig['api'];
  baseUrl?: PiModelConfig['baseUrl'];
  compat?: PiModelConfig['compat'];
}

/**
 * Get transport metadata from the built-in registry for a model, if available.
 *
 * These fields travel together on purpose. `compat` is transport-specific in Pi's model
 * type (`AnthropicMessagesCompat` vs `OpenAICompletionsCompat`), and built-in Anthropic
 * entries use a different base URL than the OpenAI-compatible ones. Applying one field
 * without the others yields an incoherent model config, so a half-described transport is
 * dropped rather than partially applied.
 */
async function getBuiltInTransport(modelId: string): Promise<BuiltInTransport | undefined> {
  const builtIn = await loadBuiltInOpenRouterModels();
  const model = builtIn.get(modelId);
  if (model === undefined) {
    return undefined;
  }

  const { api, baseUrl, compat } = model;
  const hasTransport = api !== undefined && baseUrl !== undefined;

  // compat is only meaningful next to the transport it was authored for. Keep it when the
  // transport resolved, or when the entry declares no api and inherits the provider default.
  if (!hasTransport) {
    return api === undefined && compat !== undefined ? { compat } : undefined;
  }

  return compat !== undefined ? { api, baseUrl, compat } : { api, baseUrl };
}

const COST_PER_MILLION = 1_000_000;
const DEFAULT_MAX_TOKENS = 4096;
const API_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
type ApiThinkingLevel = (typeof API_THINKING_LEVELS)[number];

function buildApiThinkingLevelMap(
  reasoning: OpenRouterModel['reasoning'],
): PiModelConfig['thinkingLevelMap'] {
  if (reasoning === undefined) {
    return undefined;
  }

  const supportedEfforts = new Set(
    reasoning?.supported_efforts === null
      ? API_THINKING_LEVELS
      : (reasoning?.supported_efforts?.filter(
          (effort): effort is ApiThinkingLevel =>
            typeof effort === 'string' &&
            (API_THINKING_LEVELS as readonly string[]).includes(effort),
        ) ?? []),
  );

  if (supportedEfforts.size === 0) {
    return reasoning.mandatory ? { off: null } : undefined;
  }

  return {
    off: reasoning.mandatory ? null : 'none',
    minimal: supportedEfforts.has('minimal') ? 'minimal' : null,
    low: supportedEfforts.has('low') ? 'low' : null,
    medium: supportedEfforts.has('medium') ? 'medium' : null,
    high: supportedEfforts.has('high') ? 'high' : null,
    xhigh: supportedEfforts.has('xhigh') ? 'xhigh' : null,
    max: supportedEfforts.has('max') ? 'max' : null,
  };
}

/**
 * Validation result for a model check.
 */
type PricedOpenRouterModel = OpenRouterModel & {
  pricing: NonNullable<OpenRouterModel['pricing']>;
};

type ValidationResult =
  | { valid: true; model: PricedOpenRouterModel; contextWindow: number }
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
  const pricing = model.pricing;
  if (!pricing?.prompt) {
    return invalidModel('missing prompt pricing', model.id);
  }
  if (!pricing.completion) {
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

  return { valid: true, model: { ...model, pricing }, contextWindow };
}

/**
 * Build PiModelConfig from a validated OpenRouterModel.
 * Merges thinkingLevelMap and transport metadata from Pi's built-in registry and
 * thinkingLevelMap from user overrides.
 * Priority: user overrides > built-in registry > API data
 */
async function buildPiConfig(
  model: PricedOpenRouterModel,
  contextWindow: number,
  userOverrides?: Awaited<ReturnType<typeof loadModelOverrides>>,
): Promise<PiModelConfig> {
  const supportedParams = model.supported_parameters ?? [];
  const hasReasoning =
    model.reasoning !== undefined
      ? true
      : supportedParams.includes('reasoning') || supportedParams.includes('include_reasoning');
  const inputModalities = model.architecture?.input_modalities;
  const supportsImages = inputModalities?.includes('image') ?? false;

  // Fetch thinkingLevelMap from built-in registry if this is a reasoning model
  const builtInThinkingLevelMap = hasReasoning
    ? await getBuiltInThinkingLevelMap(model.id)
    : undefined;

  // Transport metadata is not reasoning-specific, so it is looked up for every model.
  const builtInTransport = await getBuiltInTransport(model.id);

  // Fetch user override for this model
  const userOverride = userOverrides ? getModelOverride(userOverrides, model.id) : undefined;
  const apiThinkingLevelMap = buildApiThinkingLevelMap(model.reasoning);

  const baseThinkingLevelMap = builtInThinkingLevelMap ?? apiThinkingLevelMap;
  const thinkingLevelMap =
    baseThinkingLevelMap !== undefined || userOverride?.thinkingLevelMap !== undefined
      ? {
          ...baseThinkingLevelMap,
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

  if (builtInTransport?.api !== undefined) {
    config.api = builtInTransport.api;
  }

  if (builtInTransport?.baseUrl !== undefined) {
    config.baseUrl = builtInTransport.baseUrl;
  }

  if (builtInTransport?.compat !== undefined) {
    config.compat = builtInTransport.compat;
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

    configs.push(await buildPiConfig(validation.model, validation.contextWindow, userOverrides));
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

  return buildPiConfig(validation.model, validation.contextWindow, userOverrides);
}
