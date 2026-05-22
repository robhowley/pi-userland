/**
 * User model overrides persistence
 *
 * Manages ~/.pi/openrouter/model-overrides.json for user-defined
 * PiModelConfig field overrides.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { UserModelOverride, ModelOverridesFile, ThinkingLevelMap } from './types.js';

export class ModelOverridesLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelOverridesLoadError';
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Get the path to the overrides file.
 * Computed lazily to allow for test mocking.
 */
function getOverridesFile(): string {
  return join(homedir(), '.pi', 'openrouter', 'model-overrides.json');
}

/**
 * Load model overrides from disk.
 * Returns empty structure only when the file doesn't exist.
 * Throws when an existing file cannot be read, parsed, or validated.
 */
export async function loadModelOverrides(): Promise<ModelOverridesFile> {
  const overridesFile = getOverridesFile();
  if (!existsSync(overridesFile)) {
    return { version: 1, overrides: {} };
  }

  let content: string;
  try {
    content = await readFile(overridesFile, 'utf-8');
  } catch (error) {
    throw new ModelOverridesLoadError(
      `Failed to read model overrides file at ${overridesFile}: ${getErrorMessage(error)}`,
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(content) as unknown;
  } catch (error) {
    throw new ModelOverridesLoadError(
      `Invalid JSON in model overrides file at ${overridesFile}: ${getErrorMessage(error)}`,
    );
  }

  // Basic validation
  if (
    typeof data === 'object' &&
    data !== null &&
    'version' in data &&
    typeof (data as { version: unknown }).version === 'number' &&
    'overrides' in data &&
    typeof (data as { overrides: unknown }).overrides === 'object' &&
    (data as { overrides: unknown }).overrides !== null
  ) {
    return data as ModelOverridesFile;
  }

  throw new ModelOverridesLoadError(`Invalid model overrides file structure at ${overridesFile}`);
}

/**
 * Save model overrides to disk.
 */
export async function saveModelOverrides(overrides: ModelOverridesFile): Promise<void> {
  const overridesFile = getOverridesFile();
  const overridesDir = join(homedir(), '.pi', 'openrouter');

  // Ensure directory exists
  if (!existsSync(overridesDir)) {
    await mkdir(overridesDir, { recursive: true });
  }

  const content = JSON.stringify(overrides, null, 2);
  await writeFile(overridesFile, content, 'utf-8');
}

/**
 * Get existing override for a specific model.
 */
export function getModelOverride(
  overrides: ModelOverridesFile,
  modelId: string,
): UserModelOverride | undefined {
  return overrides.overrides[modelId];
}

/**
 * Set override for a specific model.
 * Merges with existing override.
 */
export function setModelOverride(
  overrides: ModelOverridesFile,
  modelId: string,
  override: UserModelOverride,
): ModelOverridesFile {
  const existing = overrides.overrides[modelId] ?? {};
  const mergedThinkingLevelMap =
    existing.thinkingLevelMap !== undefined || override.thinkingLevelMap !== undefined
      ? {
          ...existing.thinkingLevelMap,
          ...override.thinkingLevelMap,
        }
      : undefined;

  const merged: UserModelOverride = {
    ...existing,
    ...override,
  };

  if (mergedThinkingLevelMap !== undefined) {
    const cleaned = Object.fromEntries(
      Object.entries(mergedThinkingLevelMap).filter(([, v]) => v !== undefined),
    );
    if (Object.keys(cleaned).length > 0) {
      merged.thinkingLevelMap = cleaned as Partial<ThinkingLevelMap>;
    } else {
      delete merged.thinkingLevelMap;
    }
  }

  return {
    ...overrides,
    overrides: {
      ...overrides.overrides,
      [modelId]: merged,
    },
  };
}

/**
 * Remove override for a specific model.
 */
export function removeModelOverride(
  overrides: ModelOverridesFile,
  modelId: string,
): ModelOverridesFile {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { [modelId]: _, ...rest } = overrides.overrides;
  return {
    ...overrides,
    overrides: rest,
  };
}

/**
 * Get all model IDs that have overrides.
 */
export function getOverrideModelIds(overrides: ModelOverridesFile): string[] {
  return Object.keys(overrides.overrides);
}

/**
 * Check if any overrides exist.
 */
export function hasOverrides(overrides: ModelOverridesFile): boolean {
  return Object.keys(overrides.overrides).length > 0;
}
