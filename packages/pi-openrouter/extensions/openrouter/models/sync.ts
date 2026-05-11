/**
 * Sync engine for OpenRouter models.
 * Orchestrates model fetch, mapping, registration, and cache management.
 */

import { fetchUserModels } from '../client.js';
import { mapOpenRouterModels } from './mapper.js';
import { loadCache, saveCache } from './cache.js';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type {
  SyncResult,
  PiModelConfig,
  ModelsCache,
  OpenRouterModel,
  SkipReason,
} from './types.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Store the current sync state for status display.
let currentSyncState: SyncResult | null = null;

/**
 * Check if model sync is enabled via user config.
 * Default is true (sync enabled) if config is not set.
 *
 * Reads from ~/.pi/agent/settings.json (global settings).
 */
export function isSyncEnabled(): boolean {
  // Get global settings path
  const globalSettingsPath = join(homedir(), '.pi', 'agent', 'settings.json');

  if (!existsSync(globalSettingsPath)) {
    return true; // Default to enabled if no settings file
  }

  try {
    const settings = JSON.parse(readFileSync(globalSettingsPath, 'utf-8'));
    // Default is true (enabled) - only disabled if explicitly set to false
    return settings['openrouterModelSync'] !== false;
  } catch {
    return true; // Default to enabled if settings file can't be read
  }
}

/**
 * Set the current sync state.
 * Called after each sync operation.
 */
export function setSyncState(result: SyncResult): void {
  currentSyncState = result;
}

/**
 * Get the current sync state for status display.
 */
export function getSyncState(): SyncResult | null {
  return currentSyncState;
}

/**
 * Register mapped models with Pi's OpenRouter provider.
 *
 * Uses modelRegistry.registerProvider() to add models to the built-in openrouter provider.
 * The models array replaces all existing models for the provider.
 */
async function registerModelsWithProvider(
  ctx: ExtensionContext,
  configs: PiModelConfig[],
): Promise<void> {
  // Register models with Pi's OpenRouter provider
  // This replaces all existing models for the provider with our synced ones
  ctx.modelRegistry.registerProvider('openrouter', {
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'OPENROUTER_API_KEY',
    api: 'openai-completions',
    models: configs,
    authHeader: true,
  });

  console.log(`[pi-openrouter] Registered ${configs.length} models with OpenRouter provider`);
}

/**
 * Built-in OpenRouter router aliases that should always be available.
 * These are special routing models that don't appear in /models/user endpoint.
 */
const BUILTIN_ROUTER_MODELS: PiModelConfig[] = [
  {
    id: 'openrouter/auto',
    name: 'Auto Router',
    reasoning: true,
    input: ['text', 'image'],
    cost: {
      input: 0, // Costs vary by routed model
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 2000000,
    maxTokens: 4096,
  },
  {
    id: 'openrouter/free',
    name: 'Free Models Router',
    reasoning: true,
    input: ['text', 'image'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 200000,
    maxTokens: 4096,
  },
  {
    id: 'openrouter/owl-alpha',
    name: 'Owl Alpha',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 1048756,
    maxTokens: 262144,
  },
];

/**
 * Execute a full sync operation:
 * 1. Fetch models from OpenRouter API
 * 2. Map to Pi model config
 * 3. Register with provider
 * 4. Update cache
 *
 * On API failure, falls back to cached models if available.
 *
 * @param ctx - Extension context for provider registration
 * @returns SyncResult with details of the operation
 */
export async function syncModels(_ctx: ExtensionContext): Promise<SyncResult> {
  // Note: Config check (isSyncEnabled) is now handled at the command level
  // in index.ts. This allows tests to run without file system dependencies.

  // Attempt 1: Fetch from API
  try {
    const response = await fetchUserModels();
    const { configs, skipped, skippedDetails } = mapOpenRouterModels(response.data);

    // Add built-in router aliases that don't appear in /models/user endpoint
    const configsWithRouters = [...configs, ...BUILTIN_ROUTER_MODELS];

    // Register with Pi's OpenRouter provider
    await registerModelsWithProvider(_ctx, configsWithRouters);

    // Convert SDK Model[] to OpenRouterModel[] for cache
    // Using explicit mapping to handle SDK's camelCase -> snake_case conversion
    const cacheModels: OpenRouterModel[] = response.data.map((model) => {
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
      if (model.topProvider) {
        result.top_provider = {
          context_length: model.topProvider.contextLength ?? 0,
          max_completion_tokens: model.topProvider.maxCompletionTokens ?? 0,
        };
      }
      if (model.perRequestLimits) {
        result.per_request_limits = {
          completion_tokens: model.perRequestLimits.completionTokens ?? 0,
        };
      }

      return result;
    });

    // Add built-in router models to cache (they're not in /models/user)
    const routerCacheModels: OpenRouterModel[] = [
      {
        id: 'openrouter/auto',
        name: 'Auto Router',
        architecture: {
          input_modalities: ['text', 'image'],
          output_modalities: ['text'],
        },
        context_length: 2000000,
        pricing: {
          prompt: '0',
          completion: '0',
        },
        supported_parameters: ['reasoning'],
      },
      {
        id: 'openrouter/free',
        name: 'Free Models Router',
        architecture: {
          input_modalities: ['text', 'image'],
          output_modalities: ['text'],
        },
        context_length: 200000,
        pricing: {
          prompt: '0',
          completion: '0',
        },
        supported_parameters: ['reasoning'],
      },
      {
        id: 'openrouter/owl-alpha',
        name: 'Owl Alpha',
        architecture: {
          input_modalities: ['text'],
          output_modalities: ['text'],
        },
        context_length: 1048756,
        pricing: {
          prompt: '0',
          completion: '0',
        },
        supported_parameters: [],
      },
    ];

    // Update last-good cache (include routers and skip details)
    const cache: ModelsCache = {
      models: [...cacheModels, ...routerCacheModels],
      skippedDetails: skippedDetails,
      timestamp: Date.now(),
    };
    await saveCache(cache);

    const result: SyncResult = {
      success: true,
      registeredCount: configsWithRouters.length,
      skippedCount: skipped,
      skippedDetails: skippedDetails,
      source: 'api',
      cacheUpdated: true,
      cacheAgeMs: null,
      error: null,
    };

    setSyncState(result);
    return result;
  } catch (error) {
    // API failed - try cache fallback
    const errorMsg = error instanceof Error ? error.message : String(error);

    const cache = await loadCache();

    if (cache) {
      // Attempt 2: Use cached models
      const { configs, skipped } = mapOpenRouterModels(cache.models);

      await registerModelsWithProvider(_ctx, configs);

      // Use cached skip details if available
      const cachedSkipDetails = cache.skippedDetails || [];

      const result: SyncResult = {
        success: false,
        registeredCount: configs.length,
        skippedCount: skipped,
        source: 'cache',
        cacheUpdated: false,
        cacheAgeMs: Date.now() - cache.timestamp,
        error: errorMsg,
        skippedDetails: cachedSkipDetails,
      };

      setSyncState(result);
      return result;
    }

    // Attempt 3: No cache available - complete failure
    const result: SyncResult = {
      success: false,
      registeredCount: 0,
      skippedCount: 0,
      source: 'none',
      cacheUpdated: false,
      cacheAgeMs: null,
      error: errorMsg,
    };

    setSyncState(result);
    return result;
  }
}

/**
 * Get a human-readable status string for the current sync state.
 */
export function getStatusText(): string {
  const state = getSyncState();

  if (!state) {
    return 'OpenRouter models: not synced';
  }

  // Derive status from result
  let status: string;
  if (state.success) {
    status = 'healthy';
  } else if (state.source === 'cache') {
    status = 'cached';
  } else {
    status = 'broken';
  }

  return `OpenRouter models: ${status} (${state.registeredCount} registered)`;
}

/**
 * Check if models are currently available (synced or cached).
 */
export function areModelsAvailable(): boolean {
  const state = getSyncState();
  if (!state) return false;

  return state.registeredCount > 0 || state.source === 'cache';
}

/**
 * Get skip reasons from the current sync state or cache.
 * Note: For models-status (synchronous), we can't await here.
 * For async usage, use getSkipReasonsAsync instead.
 */
export function getSkipReasons(maxResults: number = 10): SkipReason[] {
  const state = getSyncState();
  if (!state) return [];

  // Prefer in-memory state
  if (state.skippedDetails && state.skippedDetails.length > 0) {
    return state.skippedDetails.slice(0, maxResults);
  }

  return [];
}

/**
 * Async version of getSkipReasons that reads from cache if needed.
 */
export async function getSkipReasonsAsync(maxResults: number = 10): Promise<SkipReason[]> {
  const state = getSyncState();

  // First check in-memory state
  if (state?.skippedDetails && state.skippedDetails.length > 0) {
    return state.skippedDetails.slice(0, maxResults);
  }

  // Fall back to cache if not available in state
  const cache = await loadCache();
  if (cache?.skippedDetails && cache.skippedDetails.length > 0) {
    return cache.skippedDetails.slice(0, maxResults);
  }

  return [];
}

/**
 * Format skip reasons for display.
 */
export function formatSkipReasons(reasons: SkipReason[]): string {
  if (reasons.length === 0) return '';

  const lines: string[] = [];
  for (const reason of reasons) {
    lines.push(`  - ${reason.id}: ${reason.reason}`);
  }
  return lines.join('\n');
}
