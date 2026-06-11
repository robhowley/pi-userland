import { SettingsManager } from '@earendil-works/pi-coding-agent';

export type MergeReadyConfig = {
  autoCompactRepair: boolean;
};

export const DEFAULT_MERGE_READY_CONFIG: MergeReadyConfig = {
  autoCompactRepair: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getMergeReadySettings(settings: Record<string, unknown>): unknown {
  return settings['pi-merge-ready'];
}

function mergeScopedMergeReadySettings(
  globalSettings: Record<string, unknown>,
  projectSettings: Record<string, unknown>,
): unknown {
  const globalMergeReadySettings = getMergeReadySettings(globalSettings);
  const projectMergeReadySettings = getMergeReadySettings(projectSettings);

  if (isRecord(globalMergeReadySettings) && isRecord(projectMergeReadySettings)) {
    return {
      ...globalMergeReadySettings,
      ...projectMergeReadySettings,
    };
  }

  return projectMergeReadySettings === undefined
    ? globalMergeReadySettings
    : projectMergeReadySettings;
}

function parseMergeReadyConfig(rawConfig: unknown): MergeReadyConfig {
  if (!isRecord(rawConfig)) {
    return DEFAULT_MERGE_READY_CONFIG;
  }

  return {
    autoCompactRepair:
      typeof rawConfig['autoCompactRepair'] === 'boolean'
        ? rawConfig['autoCompactRepair']
        : DEFAULT_MERGE_READY_CONFIG.autoCompactRepair,
  };
}

/**
 * Load merge-ready configuration from Pi settings.json.
 * Uses SettingsManager global + project settings layering.
 */
export function loadMergeReadyConfig(cwd: string): MergeReadyConfig {
  const settingsManager = SettingsManager.create(cwd);
  const mergedMergeReadySettings = mergeScopedMergeReadySettings(
    settingsManager.getGlobalSettings() as Record<string, unknown>,
    settingsManager.getProjectSettings() as Record<string, unknown>,
  );

  return parseMergeReadyConfig(mergedMergeReadySettings);
}

/**
 * Async version for consistency with future async patterns.
 */
export async function loadMergeReadyConfigAsync(cwd: string): Promise<MergeReadyConfig> {
  return loadMergeReadyConfig(cwd);
}
