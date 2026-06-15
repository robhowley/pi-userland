/**
 * Sync engine for OpenRouter models.
 * Orchestrates model fetch, mapping, registration, and cache management.
 */

import { fetchUserModels } from '../client.js';
import { sdkModelToOpenRouterModel } from '../normalizers.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { loadCache, saveCache } from './cache.js';
import { mapOpenRouterModels } from './mapper.js';
import { ROUTER_DEFINITIONS } from './types.js';
import type {
  ActiveCatalogState,
  CatalogMode,
  ModelsCache,
  OpenRouterModel,
  PiModelConfig,
  SkipReason,
  SyncResult,
} from './types.js';

// Store the current sync state for status display.
let currentSyncState: SyncResult | null = null;

// Store the catalog currently registered with Pi.
let currentActiveCatalogState: ActiveCatalogState | null = null;

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
export function setSyncState(result: SyncResult | null): void {
  currentSyncState = result;
}

/**
 * Get the current sync state for status display.
 */
export function getSyncState(): SyncResult | null {
  return currentSyncState;
}

/**
 * Set the currently active catalog state.
 */
export function setActiveCatalogState(state: ActiveCatalogState | null): void {
  currentActiveCatalogState = state;
}

/**
 * Get the currently active catalog state.
 */
export function getActiveCatalogState(): ActiveCatalogState | null {
  return currentActiveCatalogState;
}

/**
 * Register mapped models with Pi's OpenRouter provider.
 *
 * Uses modelRegistry.registerProvider() to replace the provider's model list with the synced
 * user-scoped catalog plus the built-in router aliases that do not appear in /models/user.
 */
export async function registerModelsWithProvider(
  ctx: ExtensionContext,
  configs: PiModelConfig[],
): Promise<void> {
  ctx.modelRegistry.registerProvider('openrouter', {
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'OPENROUTER_API_KEY',
    api: 'openai-completions',
    models: configs,
    authHeader: true,
  });
}

function getBuiltinRouterDefinitionsForCatalogMode(mode: CatalogMode) {
  return ROUTER_DEFINITIONS.filter((router) => mode === 'full' || router.id === 'openrouter/free');
}

/**
 * Returns true when an OpenRouter model ID is an explicit free variant.
 */
export function isExplicitFreeModelId(id: string): boolean {
  return id.endsWith(':free');
}

/**
 * Filter raw models for the requested catalog mode before mapping/validation.
 */
export function filterModelsForCatalogMode<T extends { id?: string }>(
  models: T[],
  mode: CatalogMode,
): T[] {
  if (mode === 'full') {
    return [...models];
  }

  return models.filter((model) => typeof model.id === 'string' && isExplicitFreeModelId(model.id));
}

/**
 * Built-in router models derived from ROUTER_DEFINITIONS in types.ts.
 * This ensures sync with mapper.ts skip logic.
 */
export function getBuiltinRoutersForCatalogMode(mode: CatalogMode): PiModelConfig[] {
  return getBuiltinRouterDefinitionsForCatalogMode(mode).map((router) => ({
    id: router.id,
    name: router.name,
    reasoning: router.reasoning,
    input: [...router.input],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: router.contextLength,
    maxTokens: router.maxTokens,
  }));
}

/**
 * Add built-in router aliases exactly once to a synced user catalog.
 */
export function includeBuiltinRouterModels(
  configs: PiModelConfig[],
  mode: CatalogMode = 'full',
): PiModelConfig[] {
  const seen = new Set(configs.map((config) => config.id));
  const routersToAdd = getBuiltinRoutersForCatalogMode(mode).filter(
    (router) => !seen.has(router.id),
  );
  return [...configs, ...routersToAdd];
}

/**
 * Convert router definitions to OpenRouterModel format for cache storage.
 */
function getRouterCacheModels(mode: CatalogMode): OpenRouterModel[] {
  return getBuiltinRouterDefinitionsForCatalogMode(mode).map((router) => ({
    id: router.id,
    name: router.name,
    architecture: {
      input_modalities: [...router.input],
      output_modalities: [...router.output],
    },
    context_length: router.contextLength,
    pricing: { prompt: '0', completion: '0' },
    supported_parameters: router.reasoning ? ['reasoning'] : [],
  }));
}

function getEffectiveSkippedCount(skipped: number, skippedDetails: SkipReason[]): number {
  return skippedDetails.length > 0 ? skippedDetails.length : skipped;
}

function buildActiveCatalogState(args: {
  mode: CatalogMode;
  registeredModelIds: string[];
  registeredCount: number;
  skippedCount: number;
  skippedDetails: SkipReason[];
  source: ActiveCatalogState['source'];
  cacheAgeMs: number;
}): ActiveCatalogState {
  return {
    mode: args.mode,
    registeredModelIds: args.registeredModelIds,
    registeredCount: args.registeredCount,
    skippedCount: args.skippedCount,
    skippedDetails: args.skippedDetails,
    source: args.source,
    cacheAgeMs: args.cacheAgeMs,
  };
}

function sliceSkipReasons(reasons: SkipReason[], maxResults?: number): SkipReason[] {
  if (maxResults === undefined) {
    return reasons;
  }
  return reasons.slice(0, maxResults);
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
 * @param requestedMode - full catalog or free-only catalog filter
 * @returns SyncResult with details of the operation
 */
export async function syncModels(
  ctx: ExtensionContext,
  requestedMode: CatalogMode = 'full',
): Promise<SyncResult> {
  // Note: Config check (isSyncEnabled) is now handled at the command level
  // in index.ts. This allows tests to run without file system dependencies.

  // Attempt 1: Fetch from API
  try {
    const response = await fetchUserModels();
    const filteredApiModels = filterModelsForCatalogMode(response.data, requestedMode);

    if (requestedMode === 'free-only' && filteredApiModels.length === 0) {
      const activeState = getActiveCatalogState();
      const result: SyncResult = {
        success: false,
        outcome: 'no-change',
        requestedMode,
        catalogMode: activeState?.mode ?? null,
        registeredCount: 0,
        skippedCount: 0,
        skippedDetails: [],
        source: 'api',
        cacheUpdated: false,
        cacheAgeMs: activeState?.cacheAgeMs ?? null,
        error: null,
      };

      setSyncState(result);
      return result;
    }

    const { configs, skipped, skippedDetails } = await mapOpenRouterModels(filteredApiModels);

    // Add built-in router aliases that don't appear in /models/user endpoint.
    const configsWithRouters = includeBuiltinRouterModels(configs, requestedMode);

    // Register with Pi's OpenRouter provider
    await registerModelsWithProvider(ctx, configsWithRouters);

    // Convert SDK Model[] to OpenRouterModel[] for cache storage.
    // Store mode-shaped raw models so free-only cache cannot resurrect paid variants.
    const cacheModels: OpenRouterModel[] = filteredApiModels.map((model) =>
      sdkModelToOpenRouterModel(model),
    );

    // Update last-good cache (include mode-shaped routers and skip details)
    const cache: ModelsCache = {
      catalogMode: requestedMode,
      models: [...cacheModels, ...getRouterCacheModels(requestedMode)],
      skippedDetails,
      timestamp: Date.now(),
    };
    await saveCache(cache);

    const skippedCount = getEffectiveSkippedCount(skipped, skippedDetails);
    const activeState = buildActiveCatalogState({
      mode: requestedMode,
      registeredModelIds: configsWithRouters.map((config) => config.id),
      registeredCount: configsWithRouters.length,
      skippedCount,
      skippedDetails,
      source: 'api',
      cacheAgeMs: 0,
    });
    setActiveCatalogState(activeState);

    const result: SyncResult = {
      success: true,
      outcome: 'synced',
      requestedMode,
      catalogMode: requestedMode,
      registeredCount: configsWithRouters.length,
      skippedCount,
      skippedDetails,
      source: 'api',
      cacheUpdated: true,
      cacheAgeMs: 0,
      error: null,
    };

    setSyncState(result);
    return result;
  } catch (error) {
    // API failed - try cache fallback
    const errorMsg = error instanceof Error ? error.message : String(error);
    const cache = await loadCache();

    if (cache) {
      // Attempt 2: Use cached models with the cache's persisted catalog mode.
      const filteredCacheModels = filterModelsForCatalogMode(cache.models, cache.catalogMode);
      const { configs, skipped, skippedDetails } = await mapOpenRouterModels(filteredCacheModels);
      const configsWithRouters = includeBuiltinRouterModels(configs, cache.catalogMode);

      await registerModelsWithProvider(ctx, configsWithRouters);

      const cachedSkipDetails = cache.skippedDetails ?? skippedDetails;
      const skippedCount = getEffectiveSkippedCount(skipped, cachedSkipDetails);
      const cacheAgeMs = Math.max(0, Date.now() - cache.timestamp);
      const activeState = buildActiveCatalogState({
        mode: cache.catalogMode,
        registeredModelIds: configsWithRouters.map((config) => config.id),
        registeredCount: configsWithRouters.length,
        skippedCount,
        skippedDetails: cachedSkipDetails,
        source: 'cache',
        cacheAgeMs,
      });
      setActiveCatalogState(activeState);

      const result: SyncResult = {
        success: false,
        outcome: 'cache-fallback',
        requestedMode,
        catalogMode: cache.catalogMode,
        registeredCount: configsWithRouters.length,
        skippedCount,
        source: 'cache',
        cacheUpdated: false,
        cacheAgeMs,
        error: errorMsg,
        skippedDetails: cachedSkipDetails,
      };

      setSyncState(result);
      return result;
    }

    // Attempt 3: No cache available - complete failure.
    // Preserve any previously active in-memory catalog.
    const activeState = getActiveCatalogState();
    const result: SyncResult = {
      success: false,
      outcome: 'unavailable',
      requestedMode,
      catalogMode: activeState?.mode ?? null,
      registeredCount: 0,
      skippedCount: 0,
      skippedDetails: [],
      source: 'none',
      cacheUpdated: false,
      cacheAgeMs: activeState?.cacheAgeMs ?? null,
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
  const activeState = getActiveCatalogState();

  if (activeState) {
    const status = activeState.source === 'cache' ? 'cached' : 'healthy';
    return `OpenRouter models: ${status} (${activeState.registeredCount} registered)`;
  }

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
 * Checks in-memory active state first, then falls back to cache file on disk.
 */
export async function areModelsAvailable(): Promise<boolean> {
  const activeState = getActiveCatalogState();
  if (activeState) {
    return activeState.registeredCount > 0;
  }

  // Check cache file on disk
  const cache = await loadCache();
  return !!cache && cache.models.length > 0;
}

/**
 * Get skip reasons from the active catalog, last sync state, or cache.
 * Note: For models-status (synchronous), we can't await here.
 * For async usage, use getSkipReasonsAsync instead.
 */
export function getSkipReasons(maxResults?: number): SkipReason[] {
  const activeState = getActiveCatalogState();
  if (activeState?.skippedDetails.length) {
    return sliceSkipReasons(activeState.skippedDetails, maxResults);
  }

  const state = getSyncState();
  if (state?.skippedDetails?.length) {
    return sliceSkipReasons(state.skippedDetails, maxResults);
  }

  return [];
}

/**
 * Async version of getSkipReasons that reads from cache if needed.
 */
export async function getSkipReasonsAsync(maxResults?: number): Promise<SkipReason[]> {
  const activeState = getActiveCatalogState();
  if (activeState?.skippedDetails.length) {
    return sliceSkipReasons(activeState.skippedDetails, maxResults);
  }

  const state = getSyncState();
  if (state?.skippedDetails?.length) {
    return sliceSkipReasons(state.skippedDetails, maxResults);
  }

  const cache = await loadCache();
  if (cache?.skippedDetails?.length) {
    return sliceSkipReasons(cache.skippedDetails, maxResults);
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

/**
 * Group skip reasons by reason type and return counts.
 */
export function groupSkipReasons(reasons: SkipReason[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const reason of reasons) {
    counts[reason.reason] = (counts[reason.reason] || 0) + 1;
  }
  return counts;
}
