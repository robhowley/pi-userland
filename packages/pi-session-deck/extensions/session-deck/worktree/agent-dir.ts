import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type {
  CreateWorktreeLaunchAgentDir,
  CreateWorktreeLaunchAgentDirMode,
  WorktreeLaunchContextEnvAction,
} from './types.js';

export const PI_CODING_AGENT_DIR_ENV = 'PI_CODING_AGENT_DIR';
export const LAUNCH_CONTEXT_SCOPE_WARNING =
  'Only controls PI_CODING_AGENT_DIR for this Pi launch; wrapper flags are out of scope.';

export interface LaunchAgentDirNormalizationOptions {
  homeDir?: string;
}

export interface LaunchAgentDirDisplayOptions {
  homeDir?: string;
}

export function normalizeLaunchAgentDirSelection(
  value: unknown,
  options: LaunchAgentDirNormalizationOptions = {},
): { ok: true; agentDir: CreateWorktreeLaunchAgentDir } | { ok: false; message: string } {
  if (value === undefined) {
    return { ok: true, agentDir: { mode: 'ambient' } };
  }

  if (!isRecord(value)) {
    return { ok: false, message: 'launch.agentDir must be an object when provided.' };
  }

  const unknownKey = Object.keys(value).find((key) => key !== 'mode' && key !== 'customDir');
  if (unknownKey !== undefined) {
    return { ok: false, message: `launch.agentDir.${unknownKey} is not supported.` };
  }

  const mode = value['mode'];
  if (!isLaunchAgentDirMode(mode)) {
    return { ok: false, message: 'launch.agentDir.mode must be ambient, default, or custom.' };
  }

  const customDir = value['customDir'];
  if (mode !== 'custom') {
    if (customDir !== undefined) {
      return { ok: false, message: 'launch.agentDir.customDir is only valid for custom mode.' };
    }
    return { ok: true, agentDir: { mode } };
  }

  if (typeof customDir !== 'string') {
    return { ok: false, message: 'launch.agentDir.customDir is required for custom mode.' };
  }

  const normalized = normalizeCustomAgentDir(customDir, options);
  if (!normalized.ok) {
    return { ok: false, message: `launch.agentDir.customDir ${normalized.message}` };
  }

  return { ok: true, agentDir: { mode: 'custom', customDir: normalized.customDir } };
}

export function buildLaunchAgentDirEnvPlan(agentDir: CreateWorktreeLaunchAgentDir): {
  envAction: WorktreeLaunchContextEnvAction;
  envAssignment?: string;
} {
  switch (agentDir.mode) {
    case 'ambient':
      return { envAction: 'inherit' };
    case 'default':
      return { envAction: 'unset' };
    case 'custom':
      return {
        envAction: 'set',
        envAssignment: `${PI_CODING_AGENT_DIR_ENV}=${agentDir.customDir}`,
      };
  }
}

export function getPiDefaultAgentDir(options: LaunchAgentDirDisplayOptions = {}): string {
  return resolve(getHomeDir(options), '.pi/agent');
}

export function getPiDefaultAgentDirDisplay(options: LaunchAgentDirDisplayOptions = {}): string {
  return shortenHomeDir(getPiDefaultAgentDir(options), options);
}

export function shortenHomeDir(value: string, options: LaunchAgentDirDisplayOptions = {}): string {
  const homeDir = getHomeDir(options);
  if (value === homeDir) {
    return '~';
  }
  return value.startsWith(`${homeDir}/`) ? `~/${value.slice(homeDir.length + 1)}` : value;
}

export function formatLaunchAgentDirModeLabel(mode: CreateWorktreeLaunchAgentDirMode): string {
  switch (mode) {
    case 'ambient':
      return 'ambient env';
    case 'default':
      return 'Pi default';
    case 'custom':
      return 'custom';
  }
}

function normalizeCustomAgentDir(
  value: string,
  options: LaunchAgentDirNormalizationOptions,
): { ok: true; customDir: string } | { ok: false; message: string } {
  if (value.includes('\0') || /[\r\n]/u.test(value)) {
    return { ok: false, message: 'must not contain newlines or NUL bytes.' };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: 'must be non-empty.' };
  }

  const expanded = expandHome(trimmed, options);
  if (expanded === null || !isAbsolute(expanded)) {
    return { ok: false, message: 'must be absolute or start with ~/.' };
  }

  return { ok: true, customDir: resolve(expanded) };
}

function expandHome(value: string, options: LaunchAgentDirNormalizationOptions): string | null {
  if (value === '~') {
    return getHomeDir(options);
  }
  if (value.startsWith('~/')) {
    return resolve(getHomeDir(options), value.slice(2));
  }
  if (value.startsWith('~')) {
    return null;
  }
  return value;
}

function getHomeDir(options: LaunchAgentDirDisplayOptions): string {
  return resolve(options.homeDir ?? process.env['HOME'] ?? homedir());
}

function isLaunchAgentDirMode(value: unknown): value is CreateWorktreeLaunchAgentDirMode {
  return value === 'ambient' || value === 'default' || value === 'custom';
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}
