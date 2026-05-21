/**
 * Shared test fixtures for OpenRouter extension tests.
 *
 * Centralizes common test data shapes to reduce duplication across test files.
 * Import: import { createValidModel, createActivityItem, ... } from './fixtures.js'
 */

import type { OpenRouterModel, ModelsCache, PiModelConfig } from '../models/types.js';
import type { ActivityItem } from '@openrouter/sdk/models/index.js';

// =============================================================================
// Environment Helpers
// =============================================================================

/**
 * Snapshot of process.env captured at module load time.
 * Used as the baseline for restoreEnv() in tests.
 */
const originalEnvSnapshot: Record<string, string | undefined> = { ...process.env };

/**
 * Restore process.env to its original state.
 * Call in beforeEach or afterEach to ensure clean environment between tests.
 */
export function restoreEnv(): void {
  process.env = { ...originalEnvSnapshot };
}

/**
 * Clear a specific environment variable.
 */
export function clearEnv(key: string): void {
  delete process.env[key];
}

/**
 * Set an environment variable for testing.
 */
export function setEnv(key: string, value: string): void {
  process.env[key] = value;
}

// =============================================================================
// Model Fixtures
// =============================================================================

/**
 * Creates a valid OpenRouterModel with sensible defaults.
 * Use overrides to customize specific properties for test cases.
 */
export function createValidModel(overrides?: Partial<OpenRouterModel>): OpenRouterModel {
  return {
    id: 'test/model',
    name: 'Test Model',
    context_length: 128000,
    pricing: {
      prompt: '0.0000005',
      completion: '0.0000015',
    },
    ...overrides,
  };
}

/**
 * Creates a valid ModelsCache with a single model.
 */
export function createMockCache(overrides: Partial<ModelsCache> = {}): ModelsCache {
  return {
    models: [createValidModel()],
    timestamp: Date.now() - 1000, // 1 second ago
    ...overrides,
  };
}

// =============================================================================
// Activity/Analytics Fixtures
// =============================================================================

/**
 * Creates a UTC date string (YYYY-MM-DD) relative to now.
 * @param daysAgo - Days to subtract from current UTC date (0 for today)
 * @returns Date string in YYYY-MM-DD format using UTC
 */
export function createTestDate(daysAgo: number): string {
  const now = new Date();
  const targetDate = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  return `${targetDate.getUTCFullYear()}-${String(targetDate.getUTCMonth() + 1).padStart(2, '0')}-${String(targetDate.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Creates an ActivityItem with sensible defaults.
 * Use overrides to customize specific properties for test cases.
 */
export function createActivityItem(overrides?: Partial<ActivityItem>): ActivityItem {
  return {
    date: createTestDate(0),
    model: 'gpt-4',
    modelPermaslug: 'gpt-4-perma',
    endpointId: 'ep-1',
    usage: 5.0,
    byokUsageInference: 0,
    requests: 10,
    promptTokens: 1000,
    completionTokens: 100,
    reasoningTokens: 0,
    providerName: 'openai',
    ...overrides,
  };
}

// =============================================================================
// PiModelConfig Fixtures
// =============================================================================

/**
 * Creates a valid PiModelConfig with sensible defaults.
 */
export function createPiModelConfig(overrides?: Partial<PiModelConfig>): PiModelConfig {
  return {
    id: 'test/model',
    name: 'Test Model',
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0.5,
      output: 1.5,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128000,
    maxTokens: 4096,
    ...overrides,
  };
}

// =============================================================================
// LocalUsageEvent Fixtures
// =============================================================================

import type { LocalUsageEvent } from '../types.js';

/**
 * Creates LocalUsageEvent objects for testing local usage aggregation.
 * Use daysAgo=0 for today, daysAgo=3 for within 7d window, etc.
 */
export function createLocalEvents(
  events: Array<{ daysAgo: number; cost: number; model?: string; provider?: string }>
): LocalUsageEvent[] {
  return events.map((e, i) => ({
    id: `local-${i}`,
    sessionId: 'test-session',
    generationId: `gen-${i}`,
    completedAt: `${createTestDate(e.daysAgo)}T12:00:00.000Z`,
    requests: 1,
    model: e.model ?? 'gpt-4',
    provider: e.provider ?? 'openai',
    promptTokens: 100,
    completionTokens: 50,
    cost: e.cost,
  }));
}
