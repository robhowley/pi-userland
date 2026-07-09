import { SettingsManager } from '@earendil-works/pi-coding-agent';

export type MergeReadyConfig = {
  autoCompactRepair: boolean;
  cacheTTLSeconds: number;
};

export const DEFAULT_MERGE_READY_CONFIG: MergeReadyConfig = {
  autoCompactRepair: true,
  cacheTTLSeconds: 60,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getMergeReadySettings(settings: unknown): unknown {
  return isRecord(settings) ? settings['pi-merge-ready'] : undefined;
}

function getAutoCompactRepair(rawConfig: unknown): boolean | undefined {
  if (!isRecord(rawConfig)) {
    return undefined;
  }

  return typeof rawConfig['autoCompactRepair'] === 'boolean'
    ? rawConfig['autoCompactRepair']
    : undefined;
}

function getCacheTTLSeconds(rawConfig: unknown): number | undefined {
  if (!isRecord(rawConfig)) {
    return undefined;
  }

  const value = rawConfig['cacheTTLSeconds'];
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/**
 * Load merge-ready configuration from Pi settings.json.
 * Uses SettingsManager global + project settings layering.
 */
export function loadMergeReadyConfig(cwd: string, projectTrusted = true): MergeReadyConfig {
  const settingsManager = SettingsManager.create(cwd);
  const globalMergeReadySettings = getMergeReadySettings(settingsManager.getGlobalSettings());
  const projectMergeReadySettings = projectTrusted
    ? getMergeReadySettings(settingsManager.getProjectSettings())
    : undefined;

  const globalAutoCompactRepair = getAutoCompactRepair(globalMergeReadySettings);
  const projectAutoCompactRepair = getAutoCompactRepair(projectMergeReadySettings);
  const globalCacheTTLSeconds = getCacheTTLSeconds(globalMergeReadySettings);
  const projectCacheTTLSeconds = getCacheTTLSeconds(projectMergeReadySettings);

  return {
    autoCompactRepair:
      projectAutoCompactRepair ??
      globalAutoCompactRepair ??
      DEFAULT_MERGE_READY_CONFIG.autoCompactRepair,
    cacheTTLSeconds:
      projectCacheTTLSeconds ?? globalCacheTTLSeconds ?? DEFAULT_MERGE_READY_CONFIG.cacheTTLSeconds,
  };
}

/**
 * Async version for consistency with future async patterns.
 */
export async function loadMergeReadyConfigAsync(
  cwd: string,
  projectTrusted = true,
): Promise<MergeReadyConfig> {
  return loadMergeReadyConfig(cwd, projectTrusted);
}
