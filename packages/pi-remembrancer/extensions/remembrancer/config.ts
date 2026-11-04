import { getAgentDir, SettingsManager } from '@earendil-works/pi-coding-agent';

export interface RemembrancerConfig {
  disabled: boolean;
}

export const DEFAULT_REMEMBRANCER_CONFIG: RemembrancerConfig = {
  disabled: false,
};

export function loadRemembrancerConfig(cwd: string, projectTrusted: boolean): RemembrancerConfig {
  const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
  const project = projectTrusted ? remembrancerSettings(settings.getProjectSettings()) : {};
  const global = remembrancerSettings(settings.getGlobalSettings());
  const disabled = (scope: Record<string, unknown>): boolean | undefined =>
    typeof scope['disabled'] === 'boolean' ? scope['disabled'] : undefined;

  return {
    disabled: disabled(project) ?? disabled(global) ?? DEFAULT_REMEMBRANCER_CONFIG.disabled,
  };
}

function remembrancerSettings(settings: unknown): Record<string, unknown> {
  if (!isRecord(settings)) return {};
  const remembrancer = settings['pi-remembrancer'];
  return isRecord(remembrancer) ? remembrancer : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
