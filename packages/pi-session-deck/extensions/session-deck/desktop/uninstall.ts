import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  getDefaultSessionDeckDesktopAppPath,
  getSessionDeckDesktopCacheDir,
  getSessionDeckDesktopStateDir,
  getSessionDeckDesktopStatePath,
  getSessionDeckDesktopTmpDir,
} from './paths.js';
import {
  isPathInside,
  readSessionDeckDesktopInstallState,
  type SessionDeckDesktopInstallState,
} from './state.js';
import type { SessionDeckDesktopCommandResult } from './command.js';

export interface UninstallSessionDeckDesktopOptions {
  homeDirectory?: string;
  removePath?: typeof rm;
  statePath?: string;
}

export async function uninstallSessionDeckDesktop(
  options: UninstallSessionDeckDesktopOptions = {},
): Promise<SessionDeckDesktopCommandResult> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const statePath = options.statePath ?? getSessionDeckDesktopStatePath(homeDirectory);
  let state: SessionDeckDesktopInstallState | null;
  try {
    state = await readSessionDeckDesktopInstallState(statePath);
  } catch (error) {
    return {
      level: 'warning',
      message: [
        'Could not uninstall Session Deck desktop app automatically.',
        `Install state at ${statePath} could not be read: ${getErrorMessage(error)}`,
        'Nothing was removed because app ownership could not be verified.',
        'Manual recovery required: remove or repair the state file and verify/remove any Session Deck desktop app manually.',
      ].join('\n'),
    };
  }

  if (state === null) {
    return {
      level: 'warning',
      message: `No Session Deck desktop install state found at ${statePath}.`,
    };
  }

  const removePath = options.removePath ?? rm;
  const removalPlan = getOwnedRemovalPlan(state, homeDirectory, statePath);
  const removedPaths: string[] = [];
  for (const [index, path] of removalPlan.safePaths.entries()) {
    try {
      await removePath(path, { recursive: true, force: true });
      removedPaths.push(path);
    } catch (error) {
      return {
        level: 'warning',
        message: formatOwnedPathRemovalFailure({
          failedPath: path,
          failure: getErrorMessage(error),
          pendingPaths: removalPlan.safePaths.slice(index + 1),
          removedPaths,
          skippedPaths: removalPlan.skippedPaths,
          statePath,
        }),
      };
    }
  }

  try {
    await removePath(statePath, { force: true });
  } catch (error) {
    return {
      level: 'warning',
      message: formatStateRemovalFailure({
        failure: getErrorMessage(error),
        removedPaths,
        skippedPaths: removalPlan.skippedPaths,
        statePath,
      }),
    };
  }

  const lines = ['Uninstalled Session Deck desktop app.'];
  if (removedPaths.length > 0) {
    lines.push('Removed owned paths:');
    for (const path of removedPaths) {
      lines.push(`- ${path}`);
    }
  } else {
    lines.push('No owned app/cache paths were present to remove.');
  }
  lines.push(`Removed state: ${statePath}`);

  if (removalPlan.skippedPaths.length > 0) {
    lines.push('Skipped unsafe ownedPaths entries:');
    for (const path of removalPlan.skippedPaths) {
      lines.push(`- ${path}`);
    }
  }

  return {
    level: removalPlan.skippedPaths.length === 0 ? 'info' : 'warning',
    message: lines.join('\n'),
  };
}

function getOwnedRemovalPlan(
  state: SessionDeckDesktopInstallState,
  homeDirectory: string,
  statePath: string,
): { safePaths: string[]; skippedPaths: string[] } {
  const defaultAppPath = resolve(getDefaultSessionDeckDesktopAppPath(homeDirectory));
  const resolvedStatePath = resolve(statePath);
  const stateDir = resolve(getSessionDeckDesktopStateDir(homeDirectory));
  const cacheDir = resolve(getSessionDeckDesktopCacheDir(homeDirectory));
  const tmpDir = resolve(getSessionDeckDesktopTmpDir(homeDirectory));
  const safePaths: string[] = [];
  const skippedPaths: string[] = [];

  for (const ownedPath of state.ownedPaths) {
    const resolvedPath = resolve(ownedPath);
    if (resolvedPath === resolvedStatePath) {
      continue;
    }

    if (
      resolvedPath === defaultAppPath ||
      isPathInside(cacheDir, resolvedPath) ||
      isPathInside(tmpDir, resolvedPath)
    ) {
      if (!safePaths.includes(resolvedPath)) {
        safePaths.push(resolvedPath);
      }
      continue;
    }

    if (isPathInside(stateDir, resolvedPath) && resolvedPath !== stateDir) {
      if (!safePaths.includes(resolvedPath)) {
        safePaths.push(resolvedPath);
      }
      continue;
    }

    skippedPaths.push(ownedPath);
  }

  return { safePaths, skippedPaths };
}

function formatOwnedPathRemovalFailure(options: {
  failedPath: string;
  failure: string;
  pendingPaths: string[];
  removedPaths: string[];
  skippedPaths: string[];
  statePath: string;
}): string {
  const lines = [
    'Session Deck desktop uninstall stopped after an owned path could not be removed.',
    'Removed owned paths:',
    ...formatPaths(options.removedPaths),
    'Failed owned path:',
    `- ${options.failedPath}: ${options.failure}`,
    'Pending owned paths:',
    ...formatPaths(options.pendingPaths),
    `Install state retained for retry: ${options.statePath}`,
  ];
  appendSkippedPaths(lines, options.skippedPaths);
  return lines.join('\n');
}

function formatStateRemovalFailure(options: {
  failure: string;
  removedPaths: string[];
  skippedPaths: string[];
  statePath: string;
}): string {
  const lines = [
    'Session Deck desktop safe owned-path cleanup completed, but install state removal failed.',
    'Removed owned paths:',
    ...formatPaths(options.removedPaths),
    'Failed state path:',
    `- ${options.statePath}: ${options.failure}`,
    'Pending owned paths:',
    '- (none)',
    'Retry /session-deck desktop uninstall to finish state cleanup.',
  ];
  appendSkippedPaths(lines, options.skippedPaths);
  return lines.join('\n');
}

function formatPaths(paths: string[]): string[] {
  return paths.length === 0 ? ['- (none)'] : paths.map((path) => `- ${path}`);
}

function appendSkippedPaths(lines: string[], skippedPaths: string[]): void {
  if (skippedPaths.length === 0) {
    return;
  }

  lines.push('Skipped unsafe ownedPaths entries:', ...skippedPaths.map((path) => `- ${path}`));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
