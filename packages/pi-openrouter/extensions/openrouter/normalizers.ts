import type { Model as SDKModel } from '@openrouter/sdk/models/index.js';
import type { GetCurrentKeyData, ListData } from '@openrouter/sdk/models/operations/index.js';
import type { BYOKStatus, ResetCadence } from './account-types.js';
import type { OpenRouterModel } from './models/types.js';

export interface NormalizedKeyMetadata {
  name: string;
  label: string;
  used: number;
  resetCadence: ResetCadence;
  byok: BYOKStatus;
  hash: string;
  disabled: boolean;
  limit?: number;
  remaining?: number;
}

/**
 * Convert SDK Model to our canonical OpenRouterModel shape.
 * This isolates SDK camelCase/null handling at the package boundary.
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

  if (topProvider) {
    result.top_provider = topProvider;
  }
  if (perRequestLimits) {
    result.per_request_limits = perRequestLimits;
  }

  return result;
}

/**
 * Normalize mixed SDK/canonical model inputs into the package's canonical shape.
 */
export function normalizeOpenRouterModel(model: OpenRouterModel | SDKModel): OpenRouterModel {
  return 'contextLength' in model ? sdkModelToOpenRouterModel(model as SDKModel) : model;
}

/**
 * Normalize SDK key metadata into the package's canonical internal shape.
 * Converts SDK null/variant fields once so account code can stay domain-focused.
 */
export function normalizeSdkKeyMetadata(raw: GetCurrentKeyData | ListData): NormalizedKeyMetadata {
  const used = raw.usage ?? raw.usageMonthly ?? 0;
  const limit = raw.limit ?? undefined;
  const remaining = raw.limitRemaining ?? undefined;

  let byok: BYOKStatus = '?';
  if (raw.includeByokInLimit === true) {
    byok = 'incl';
  } else if (raw.includeByokInLimit === false) {
    byok = 'excl';
  }

  let resetCadence: ResetCadence = 'partial';
  if (raw.limitReset) {
    const reset = raw.limitReset.toLowerCase();
    if (reset === 'monthly') {
      resetCadence = 'monthly';
    } else if (reset === 'daily') {
      resetCadence = 'daily';
    } else if (reset === 'never') {
      resetCadence = 'never';
    }
  }

  const normalized: NormalizedKeyMetadata = {
    name: 'name' in raw ? (raw as ListData).name : raw.label,
    label: raw.label,
    used,
    resetCadence,
    byok,
    hash: 'hash' in raw ? (raw as ListData).hash : 'unknown',
    disabled: 'disabled' in raw ? (raw as ListData).disabled : false,
  };

  if (limit !== undefined) {
    normalized.limit = limit;
  }
  if (remaining !== undefined) {
    normalized.remaining = remaining;
  }

  return normalized;
}
