import { constants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { validateSessionDeckDesktopAppBundle } from './bundle.js';
import {
  getSessionDeckDesktopStatePath,
  resolveSessionDeckDesktopRuntimePaths,
  type SessionDeckDesktopRuntimePaths,
} from './paths.js';
import {
  hashSessionDeckDesktopPath,
  readSessionDeckDesktopInstallState,
  type SessionDeckDesktopInstallState,
} from './state.js';
import type { SessionDeckDesktopCommandResult } from './command.js';

export interface DoctorSessionDeckDesktopOptions {
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  runtimePaths?: SessionDeckDesktopRuntimePaths;
  statePath?: string;
}

export async function doctorSessionDeckDesktopInstall(
  options: DoctorSessionDeckDesktopOptions = {},
): Promise<SessionDeckDesktopCommandResult> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const statePath = options.statePath ?? getSessionDeckDesktopStatePath(homeDirectory);
  let state: SessionDeckDesktopInstallState | null = null;
  let stateReadError: string | null = null;
  try {
    state = await readSessionDeckDesktopInstallState(statePath);
  } catch (error) {
    stateReadError = getErrorMessage(error);
  }

  const lines = ['Session Deck desktop doctor'];
  const issues: string[] = [];
  const platform = options.platform ?? process.platform;
  lines.push(`- platform: ${platform}`);
  if (platform !== 'darwin') {
    issues.push('Session Deck desktop app support is macOS-only.');
  }

  lines.push(
    `- state: ${stateReadError === null ? (state === null ? 'missing' : statePath) : `invalid (${statePath})`}`,
  );

  if (stateReadError !== null) {
    issues.push(`Install state at ${statePath} could not be read: ${stateReadError}`);
    issues.push(
      'Manual recovery required: remove or repair the state file and verify/remove any Session Deck desktop app manually.',
    );
  } else if (state === null) {
    issues.push(`Install state not found at ${statePath}. Run /session-deck desktop install.`);
  } else {
    await checkInstalledApp(state, lines, issues);
    appendSource(lines, state);
  }

  let runtimePaths: SessionDeckDesktopRuntimePaths | null = options.runtimePaths ?? null;
  if (runtimePaths === null) {
    try {
      runtimePaths = await resolveSessionDeckDesktopRuntimePaths(import.meta.url);
    } catch (error) {
      issues.push(`Could not resolve current package runtime paths: ${getErrorMessage(error)}`);
    }
  }

  if (runtimePaths !== null) {
    await checkRuntimePaths(runtimePaths, state, lines, issues);
  }

  if (issues.length > 0) {
    lines.push('');
    lines.push('Issues:');
    for (const issue of issues) {
      lines.push(`- ${issue}`);
    }
  }

  return {
    level: issues.length === 0 ? 'info' : 'warning',
    message: lines.join('\n'),
  };
}

async function checkInstalledApp(
  state: SessionDeckDesktopInstallState,
  lines: string[],
  issues: string[],
): Promise<void> {
  const appExists = await pathIsDirectory(state.app.path);
  lines.push(`- app: ${state.app.path}${appExists ? '' : ' (missing)'}`);
  lines.push(`- bundle id: ${state.app.bundleIdentifier}`);
  lines.push(`- app version: ${state.app.version}`);

  if (!appExists) {
    issues.push(`Installed app is missing: ${state.app.path}`);
    return;
  }

  try {
    const bundle = await validateSessionDeckDesktopAppBundle(state.app.path);
    if (bundle.bundleIdentifier !== state.app.bundleIdentifier) {
      issues.push(
        `Installed app bundle identifier ${bundle.bundleIdentifier} does not match recorded ${state.app.bundleIdentifier}.`,
      );
    }
    if (bundle.version !== state.app.version) {
      issues.push(
        `Installed app version ${bundle.version} does not match recorded ${state.app.version}.`,
      );
    }
  } catch (error) {
    issues.push(`Installed app bundle is invalid: ${getErrorMessage(error)}`);
  }

  try {
    const installedSha256 = await hashSessionDeckDesktopPath(state.app.path);
    lines.push(`- app sha256: ${installedSha256}`);
    if (installedSha256 !== state.app.sha256) {
      issues.push('Installed app checksum differs from recorded state. Reinstall recommended.');
    }
  } catch (error) {
    issues.push(`Installed app checksum could not be calculated: ${getErrorMessage(error)}`);
  }
}

async function checkRuntimePaths(
  runtimePaths: SessionDeckDesktopRuntimePaths,
  state: SessionDeckDesktopInstallState | null,
  lines: string[],
  issues: string[],
): Promise<void> {
  lines.push(`- package root: ${runtimePaths.packageRoot}`);
  lines.push(`- helper package version: ${runtimePaths.packageVersion}`);
  lines.push(`- node executable: ${runtimePaths.nodeExecutablePath}`);

  if (!(await pathIsDirectory(runtimePaths.packageRoot))) {
    issues.push(`Package root is missing: ${runtimePaths.packageRoot}`);
  }

  try {
    await access(runtimePaths.nodeExecutablePath, constants.X_OK);
  } catch {
    issues.push(`Node executable is not available/executable: ${runtimePaths.nodeExecutablePath}`);
  }

  if (state !== null) {
    if (state.packageVersion !== runtimePaths.packageVersion) {
      issues.push(
        `Installed state package version ${state.packageVersion} does not match current package version ${runtimePaths.packageVersion}. Reinstall recommended.`,
      );
    }
    if (state.runtime.helperPackageVersion !== runtimePaths.packageVersion) {
      issues.push(
        `Installed helper package version ${state.runtime.helperPackageVersion} does not match current package version ${runtimePaths.packageVersion}. Reinstall recommended.`,
      );
    }
    if (state.runtime.packageRoot !== runtimePaths.packageRoot) {
      issues.push('Package root changed since install. Reinstall recommended.');
    }
    if (state.runtime.nodeExecutablePath !== runtimePaths.nodeExecutablePath) {
      issues.push('Node executable path changed since install. Reinstall recommended.');
    }
  }
}

function appendSource(lines: string[], state: SessionDeckDesktopInstallState): void {
  if (state.source.kind === 'local-path') {
    lines.push(`- source: local path ${state.source.path}`);
    return;
  }

  lines.push(`- source: GitHub Release ${state.source.releaseTag} asset ${state.source.assetName}`);
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    const pathStat = await lstat(path);
    return pathStat.isDirectory();
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
