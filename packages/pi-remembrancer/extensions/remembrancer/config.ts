import { getAgentDir, SettingsManager } from '@earendil-works/pi-coding-agent';

export interface RemembrancerConfig {
  disabled: boolean;
  autoCapture: boolean;
}

export const DEFAULT_REMEMBRANCER_CONFIG: RemembrancerConfig = {
  disabled: false,
  autoCapture: false,
};

export function loadRemembrancerConfig(cwd: string, projectTrusted: boolean): RemembrancerConfig {
  const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
  const project = projectTrusted ? remembrancerSettings(settings.getProjectSettings()) : {};
  const global = remembrancerSettings(settings.getGlobalSettings());
  const booleanSetting = (
    scope: Record<string, unknown>,
    name: keyof RemembrancerConfig,
  ): boolean | undefined => (typeof scope[name] === 'boolean' ? scope[name] : undefined);

  return {
    disabled:
      booleanSetting(project, 'disabled') ??
      booleanSetting(global, 'disabled') ??
      DEFAULT_REMEMBRANCER_CONFIG.disabled,
    autoCapture:
      booleanSetting(project, 'autoCapture') ??
      booleanSetting(global, 'autoCapture') ??
      DEFAULT_REMEMBRANCER_CONFIG.autoCapture,
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
