import { normalize } from 'node:path';
import { SettingsManager, getAgentDir } from '@earendil-works/pi-coding-agent';
import { validateReservation } from './description-publisher.mjs';

export interface DescriptionReservation {
  socketPath: string;
  windowId: string;
  workspaceId: string;
}

export interface JunctionConfig {
  disableStatus: boolean;
  enablePresentation: boolean;
  descriptionReservations: readonly DescriptionReservation[];
}

export const DEFAULT_JUNCTION_CONFIG: JunctionConfig = {
  disableStatus: false,
  enablePresentation: false,
  descriptionReservations: [],
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
  const reservations = Array.isArray(global['descriptionReservations'])
    ? global['descriptionReservations'].map((value) => validateReservation(value, undefined))
    : [];
  return {
    disableStatus: boolean('disableStatus'),
    enablePresentation: boolean('enablePresentation'),
    descriptionReservations: reservations.filter(
      (value): value is DescriptionReservation => value !== null,
    ),
  };
}

export function matchDescriptionReservation(
  reservations: readonly DescriptionReservation[],
  target: { socketPath: string; workspaceId: string },
): DescriptionReservation | undefined {
  const matches = reservations.filter(
    (value) =>
      normalize(value.socketPath) === normalize(target.socketPath) &&
      value.workspaceId.toLowerCase() === target.workspaceId.toLowerCase(),
  );
  // Ambiguous authority must not select a window by list order.
  return matches.length === 1 ? matches[0] : undefined;
}

function junctionSettings(settings: unknown): Record<string, unknown> {
  if (!isRecord(settings)) return {};
  const junction = settings['pi-cmux-junction'];
  return isRecord(junction) ? junction : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
