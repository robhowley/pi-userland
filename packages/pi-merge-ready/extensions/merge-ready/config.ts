import { SettingsManager } from '@earendil-works/pi-coding-agent';

export type MergeReadyConfig = {
  autoCompactRepair: boolean;
};

export const DEFAULT_MERGE_READY_CONFIG: MergeReadyConfig = {
  autoCompactRepair: true,
};

/**
 * Load merge-ready configuration from Pi settings.json.
 * Uses SettingsManager to auto-resolve global/project layering.
 */
export function loadMergeReadyConfig(cwd: string): MergeReadyConfig {
  const settingsManager = SettingsManager.create(cwd);
  const settings = settingsManager.getGlobalSettings();

  const mrSettings = settings['pi-merge-ready' as keyof typeof settings];
  if (typeof mrSettings === 'object' && mrSettings !== null) {
    const config = mrSettings as Record<string, unknown>;
    return {
      autoCompactRepair:
        typeof config['autoCompactRepair'] === 'boolean'
          ? config['autoCompactRepair']
          : DEFAULT_MERGE_READY_CONFIG.autoCompactRepair,
    };
  }

  return DEFAULT_MERGE_READY_CONFIG;
}

/**
 * Async version for consistency with future async patterns.
 */
export async function loadMergeReadyConfigAsync(cwd: string): Promise<MergeReadyConfig> {
  return loadMergeReadyConfig(cwd);
}
