import { SettingsManager, getAgentDir } from '@earendil-works/pi-coding-agent';

export interface JunctionConfig {
  disableStatus: boolean;
  enablePresentation: boolean;
}

export const DEFAULT_JUNCTION_CONFIG: JunctionConfig = {
  disableStatus: false,
  enablePresentation: false,
};

export function loadJunctionConfig(cwd: string, projectTrusted: boolean): JunctionConfig {
  const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
  const project = projectTrusted ? junctionSettings(settings.getProjectSettings()) : {};
  const global = junctionSettings(settings.getGlobalSettings());
  const boolean = (key: 'disableStatus' | 'enablePresentation'): boolean =>
    typeof project[key] === 'boolean'
      ? project[key]
      : typeof global[key] === 'boolean'
        ? global[key]
        : DEFAULT_JUNCTION_CONFIG[key];
  return {
    disableStatus: boolean('disableStatus'),
    enablePresentation:
      global['enablePresentation'] === true && project['enablePresentation'] !== false,
  };
}

function junctionSettings(settings: unknown): Record<string, unknown> {
  if (!isRecord(settings)) return {};
  const junction = settings['pi-cmux-junction'];
  return isRecord(junction) ? junction : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
