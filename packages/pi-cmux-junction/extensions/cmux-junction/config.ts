import { SettingsManager, getAgentDir } from '@earendil-works/pi-coding-agent';

export interface JunctionConfig {
  disableStatus: boolean;
}

export const DEFAULT_JUNCTION_CONFIG: JunctionConfig = {
  disableStatus: false,
};

export function loadJunctionConfig(cwd: string, projectTrusted: boolean): JunctionConfig {
  const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted });
  const projectDisableStatus = projectTrusted
    ? readDisableStatus(settings.getProjectSettings())
    : undefined;
  const globalDisableStatus = readDisableStatus(settings.getGlobalSettings());

  return {
    disableStatus:
      projectDisableStatus ?? globalDisableStatus ?? DEFAULT_JUNCTION_CONFIG.disableStatus,
  };
}

function readDisableStatus(settings: unknown): boolean | undefined {
  if (!isRecord(settings)) return undefined;
  const junction = settings['pi-cmux-junction'];
  if (!isRecord(junction)) return undefined;
  return typeof junction['disableStatus'] === 'boolean' ? junction['disableStatus'] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
