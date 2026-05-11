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
  pricing: {
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
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
  success: boolean;
  registeredCount: number;
  skippedCount: number;
  source: 'api' | 'cache' | 'none';
  cacheUpdated: boolean;
  cacheAgeMs: number | null;
  error: string | null;
}

/**
 * Cache file structure
 */
export interface ModelsCache {
  models: OpenRouterModel[];
  timestamp: number;
}

/**
 * Current sync state for status display
 */
export interface SyncState {
  registeredCount: number;
  skippedCount: number;
  source: 'api' | 'cache' | 'none';
  lastSuccessfulSync: number | null; // timestamp ms
  lastError: string | null;
  cacheAgeMs: number | null;
}

/**
 * Result of batch mapping operation
 */
export interface MapResult {
  configs: PiModelConfig[];
  skipped: number;
}
