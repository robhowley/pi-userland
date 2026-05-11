/**
 * Sync engine for OpenRouter models.
 * Orchestrates model fetch, mapping, registration, and cache management.
 */

import { fetchUserModels } from '../client.js';
import { mapOpenRouterModels } from './mapper.js';
import { loadCache, saveCache } from './cache.js';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { SyncResult, PiModelConfig, ModelsCache, OpenRouterModel } from './types.js';
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
function isSyncEnabled(): boolean {
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
 * TODO: This is a placeholder. Update when Pi's provider API is finalized.
 * The actual implementation may differ based on the real API.
 */
async function registerModelsWithProvider(
  _ctx: ExtensionContext,
  _configs: PiModelConfig[],
): Promise<void> {
  // Placeholder: In real implementation, this would:
  // 1. Clear existing OpenRouter models from provider
  // 2. Register each config with the provider
  //
  // Example of likely API:
  // await _ctx.providers.openrouter.clearModels();
  // for (const config of configs) {
  //   await _ctx.providers.openrouter.registerModel(config);
  // }

  // For now, just log registration
  console.log(`[pi-openrouter] Registering models with provider`);

  // Simulate async work
  await Promise.resolve();
}

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
  // Check if sync is enabled via user config
  if (!isSyncEnabled()) {
    console.log('[pi-openrouter] Model sync disabled by config');
    const result: SyncResult = {
      success: false,
      registeredCount: 0,
      skippedCount: 0,
      source: 'none',
      cacheUpdated: false,
      cacheAgeMs: null,
      error: 'openrouterModelSync is disabled',
    };
    setSyncState(result);
    return result;
  }

  // Attempt 1: Fetch from API
  try {
    const response = await fetchUserModels();
    const { configs, skipped } = mapOpenRouterModels(response.data);

    // Register with Pi's OpenRouter provider
    await registerModelsWithProvider(_ctx, configs);

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

    // Update last-good cache
    const cache: ModelsCache = {
      models: cacheModels,
      timestamp: Date.now(),
    };
    await saveCache(cache);

    const result: SyncResult = {
      success: true,
      registeredCount: configs.length,
      skippedCount: skipped,
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

      const result: SyncResult = {
        success: false,
        registeredCount: configs.length,
        skippedCount: skipped,
        source: 'cache',
        cacheUpdated: false,
        cacheAgeMs: Date.now() - cache.timestamp,
        error: errorMsg,
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
