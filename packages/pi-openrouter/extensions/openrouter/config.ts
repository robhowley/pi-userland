import { SettingsManager } from '@earendil-works/pi-coding-agent';

export type OpenRouterConfig = {
  statusEnabled: boolean;
};

export const DEFAULT_OPENROUTER_CONFIG: OpenRouterConfig = {
  statusEnabled: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getOpenRouterSettings(settings: Record<string, unknown>): unknown {
  return settings['pi-openrouter'];
}

function mergeScopedOpenRouterSettings(
  globalSettings: Record<string, unknown>,
  projectSettings: Record<string, unknown>,
): unknown {
  const globalOpenRouterSettings = getOpenRouterSettings(globalSettings);
  const projectOpenRouterSettings = getOpenRouterSettings(projectSettings);

  if (isRecord(globalOpenRouterSettings) && isRecord(projectOpenRouterSettings)) {
    return {
      ...globalOpenRouterSettings,
      ...projectOpenRouterSettings,
    };
  }

  return projectOpenRouterSettings === undefined
    ? globalOpenRouterSettings
    : projectOpenRouterSettings;
}

function parseOpenRouterConfig(rawConfig: unknown): OpenRouterConfig {
  if (!isRecord(rawConfig)) {
    return DEFAULT_OPENROUTER_CONFIG;
  }

  return {
    statusEnabled:
      typeof rawConfig['statusEnabled'] === 'boolean'
        ? rawConfig['statusEnabled']
        : DEFAULT_OPENROUTER_CONFIG.statusEnabled,
  };
}

export function loadOpenRouterConfig(cwd: string, projectTrusted = true): OpenRouterConfig {
  const settingsManager = SettingsManager.create(cwd);
  const globalSettings = settingsManager.getGlobalSettings() as Record<string, unknown>;
  const projectSettings = projectTrusted
    ? (settingsManager.getProjectSettings() as Record<string, unknown>)
    : {};

  return parseOpenRouterConfig(mergeScopedOpenRouterSettings(globalSettings, projectSettings));
}

export function isStatusEnabled(cwd: string, projectTrusted = true): boolean {
  return loadOpenRouterConfig(cwd, projectTrusted).statusEnabled;
}
