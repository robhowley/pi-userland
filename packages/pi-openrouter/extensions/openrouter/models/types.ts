/**
 * Raw OpenRouter model from /api/v1/models/user
 */
export interface OpenRouterModel {
  id: string;
  name?: string;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  context_length: number;
  pricing?: {
    prompt: string; // per-token price as string
    completion: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
  supported_parameters?: string[];
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
  };
  per_request_limits?: {
    completion_tokens?: number;
  };
}

/**
 * Response wrapper from /models/user endpoint
 */
export interface OpenRouterModelsResponse {
  data: OpenRouterModel[];
}

/**
 * Pi thinking level map - copied from pi-ai's Model type.
 * Levels mapped to null are hidden in Pi's UI.
 * Levels mapped to strings are sent to the provider API.
 */
export interface ThinkingLevelMap {
  off?: string | null;
  minimal?: string | null;
  low?: string | null;
  medium?: string | null;
  high?: string | null;
  xhigh?: string | null;
}

/**
 * Mapped Pi model configuration for provider registration
 */
export interface PiModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  input: ('text' | 'image')[];
  cost: {
    input: number; // $ per 1M tokens
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: ThinkingLevelMap;
}

/**
 * Registered catalog mode.
 */
export type CatalogMode = 'full' | 'free-only';

/**
 * Source for the currently active OpenRouter catalog.
 */
export type CatalogSource = 'api' | 'cache' | 'stale';

/**
 * Rich classification for the last sync attempt.
 */
export type SyncOutcome = 'synced' | 'cache-fallback' | 'no-change' | 'unavailable';

/**
 * Result of a sync operation.
 */
export interface SyncResult {
  success: boolean;
  outcome: SyncOutcome;
  requestedMode: CatalogMode;
  catalogMode: CatalogMode | null;
  registeredCount: number;
  skippedCount: number;
  skippedDetails?: SkipReason[]; // Track why models were skipped
  source: CatalogSource | 'none';
  cacheUpdated: boolean;
  cacheAgeMs: number | null;
  error: string | null;
}

/**
 * Snapshot of the catalog currently registered with Pi.
 */
export interface ActiveCatalogState {
  mode: CatalogMode;
  registeredModelIds?: string[];
  registeredCount: number;
  skippedCount: number;
  skippedDetails: SkipReason[];
  source: CatalogSource;
  cacheAgeMs: number;
}

/**
 * Cache file structure - using our OpenRouterModel type for consistency.
 * Stores the raw models for the currently active catalog mode.
 */
export interface ModelsCache {
  catalogMode: CatalogMode;
  models: OpenRouterModel[];
  skippedDetails?: SkipReason[]; // New field for tracking skip reasons
  timestamp: number;
}

/**
 * Reason a model was skipped during mapping.
 */
export interface SkipReason {
  id: string;
  reason: string;
  hint?: string;
}

/**
 * Result of batch mapping operation
 */
export interface MapResult {
  configs: PiModelConfig[];
  skipped: number;
  skippedDetails: SkipReason[];
}

// =============================================================================
// User Override Types
// =============================================================================

/**
 * User-defined override for any PiModelConfig field.
 * Stored in ~/.pi/openrouter/model-overrides.json
 *
 * For type safety, fields must be validated before storage.
 * Unknown fields are ignored during merge.
 */
export interface UserModelOverride {
  // Nested thinking level map - mapped from 'thinking.X' scoped syntax
  thinkingLevelMap?: Partial<ThinkingLevelMap>;

  // Top-level PiModelConfig overrides
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
}

/**
 * The overrides file structure.
 */
export interface ModelOverridesFile {
  version: number;
  overrides: Record<string, UserModelOverride>;
}

// =============================================================================
// Built-in Router Definitions (Single Source of Truth)
// =============================================================================

/**
 * Canonical router definitions for OpenRouter's special routing models.
 * These don't appear in /models/user API but should always be available.
 */
export const ROUTER_DEFINITIONS = [
  {
    id: 'openrouter/auto',
    name: 'Auto Router',
    reasoning: true,
    input: ['text', 'image'] as const,
    output: ['text'] as const,
    contextLength: 2000000,
    maxTokens: 4096,
  },
  {
    id: 'openrouter/free',
    name: 'Free Models Router',
    reasoning: true,
    input: ['text', 'image'] as const,
    output: ['text'] as const,
    contextLength: 200000,
    maxTokens: 4096,
  },
  {
    id: 'openrouter/owl-alpha',
    name: 'Owl Alpha',
    reasoning: false,
    input: ['text'] as const,
    output: ['text'] as const,
    contextLength: 1048756,
    maxTokens: 262144,
  },
] as const;

/**
 * Router IDs extracted from ROUTER_DEFINITIONS for quick lookup.
 * Use this for skip checks and filtering.
 */
export const ROUTER_ALIASES: readonly string[] = ROUTER_DEFINITIONS.map((r) => r.id);

// =============================================================================
// Time Constants
// =============================================================================

/** Milliseconds per minute */
export const MS_PER_MINUTE = 60000;

/** Milliseconds per hour */
export const MS_PER_HOUR = 3600000;

/** Milliseconds per day */
export const MS_PER_DAY = 86400000;
