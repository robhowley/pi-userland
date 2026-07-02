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

function getOpenRouterSettings(settings: unknown): unknown {
  return isRecord(settings) ? settings['pi-openrouter'] : undefined;
}

function getStatusEnabled(rawConfig: unknown): boolean | undefined {
  if (!isRecord(rawConfig)) {
    return undefined;
  }

  return typeof rawConfig['statusEnabled'] === 'boolean' ? rawConfig['statusEnabled'] : undefined;
}

export function loadOpenRouterConfig(cwd: string, projectTrusted = true): OpenRouterConfig {
  const settingsManager = SettingsManager.create(cwd);
  const globalStatusEnabled = getStatusEnabled(
    getOpenRouterSettings(settingsManager.getGlobalSettings()),
  );
  const projectStatusEnabled = projectTrusted
    ? getStatusEnabled(getOpenRouterSettings(settingsManager.getProjectSettings()))
    : undefined;

  return {
    statusEnabled:
      projectStatusEnabled ?? globalStatusEnabled ?? DEFAULT_OPENROUTER_CONFIG.statusEnabled,
  };
}

export function isStatusEnabled(cwd: string, projectTrusted = true): boolean {
  return loadOpenRouterConfig(cwd, projectTrusted).statusEnabled;
}
