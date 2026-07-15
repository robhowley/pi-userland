import { SettingsManager } from '@earendil-works/pi-coding-agent';
import { isMergeReadyRepairGuidanceId, type MergeReadyRepairGuidanceMap } from './types.js';

export type MergeReadyConfig = {
  autoCompactRepair: boolean;
  cacheTTLSeconds: number;
  enableStatusBarDiagnostics: boolean;
  repairGuidance: MergeReadyRepairGuidanceMap;
};

export const DEFAULT_MERGE_READY_CONFIG: MergeReadyConfig = {
  autoCompactRepair: true,
  cacheTTLSeconds: 60,
  enableStatusBarDiagnostics: false,
  repairGuidance: {},
};

export type LoadMergeReadyConfigOptions = {
  repairGuidanceProjectTrusted?: boolean;
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

function getEnableStatusBarDiagnostics(rawConfig: unknown): boolean | undefined {
  if (!isRecord(rawConfig)) {
    return undefined;
  }

  return typeof rawConfig['enableStatusBarDiagnostics'] === 'boolean'
    ? rawConfig['enableStatusBarDiagnostics']
    : undefined;
}

function getRepairGuidance(rawConfig: unknown): MergeReadyRepairGuidanceMap | undefined {
  if (!isRecord(rawConfig)) {
    return undefined;
  }

  const rawRepairGuidance = rawConfig['repairGuidance'];
  if (!isRecord(rawRepairGuidance)) {
    return undefined;
  }

  const repairGuidance: MergeReadyRepairGuidanceMap = {};
  for (const [key, value] of Object.entries(rawRepairGuidance)) {
    if (!isMergeReadyRepairGuidanceId(key) || typeof value !== 'string') {
      continue;
    }

    const trimmedValue = value.trim();
    if (trimmedValue.length === 0) {
      continue;
    }

    repairGuidance[key] = trimmedValue;
  }

  return repairGuidance;
}

/**
 * Load merge-ready configuration from Pi settings.json.
 * Uses SettingsManager global + project settings layering.
 */
export function loadMergeReadyConfig(
  cwd: string,
  projectTrusted = false,
  options: LoadMergeReadyConfigOptions = {},
): MergeReadyConfig {
  const settingsManager = SettingsManager.create(cwd);
  const projectSettings = settingsManager.getProjectSettings();
  const repairGuidanceProjectTrusted = options.repairGuidanceProjectTrusted ?? projectTrusted;
  const globalMergeReadySettings = getMergeReadySettings(settingsManager.getGlobalSettings());
  const projectMergeReadySettings = projectTrusted
    ? getMergeReadySettings(projectSettings)
    : undefined;
  const projectRepairGuidanceSettings = repairGuidanceProjectTrusted
    ? getMergeReadySettings(projectSettings)
    : undefined;

  const globalAutoCompactRepair = getAutoCompactRepair(globalMergeReadySettings);
  const projectAutoCompactRepair = getAutoCompactRepair(projectMergeReadySettings);
  const globalCacheTTLSeconds = getCacheTTLSeconds(globalMergeReadySettings);
  const projectCacheTTLSeconds = getCacheTTLSeconds(projectMergeReadySettings);
  const globalEnableStatusBarDiagnostics = getEnableStatusBarDiagnostics(globalMergeReadySettings);
  const projectEnableStatusBarDiagnostics =
    getEnableStatusBarDiagnostics(projectMergeReadySettings);
  const globalRepairGuidance = getRepairGuidance(globalMergeReadySettings);
  const projectRepairGuidance = getRepairGuidance(projectRepairGuidanceSettings);

  return {
    autoCompactRepair:
      projectAutoCompactRepair ??
      globalAutoCompactRepair ??
      DEFAULT_MERGE_READY_CONFIG.autoCompactRepair,
    cacheTTLSeconds:
      projectCacheTTLSeconds ?? globalCacheTTLSeconds ?? DEFAULT_MERGE_READY_CONFIG.cacheTTLSeconds,
    enableStatusBarDiagnostics:
      projectEnableStatusBarDiagnostics ??
      globalEnableStatusBarDiagnostics ??
      DEFAULT_MERGE_READY_CONFIG.enableStatusBarDiagnostics,
    repairGuidance: {
      ...(globalRepairGuidance ?? DEFAULT_MERGE_READY_CONFIG.repairGuidance),
      ...(projectRepairGuidance ?? {}),
    },
  };
}

/**
 * Async version for consistency with future async patterns.
 */
export async function loadMergeReadyConfigAsync(
  cwd: string,
  projectTrusted = false,
  options: LoadMergeReadyConfigOptions = {},
): Promise<MergeReadyConfig> {
  return loadMergeReadyConfig(cwd, projectTrusted, options);
}
