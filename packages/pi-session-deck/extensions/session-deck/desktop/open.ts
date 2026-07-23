import { execFile as nodeExecFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  readSessionDeckDesktopInstallState,
  type SessionDeckDesktopInstallState,
} from './state.js';
import { getSessionDeckDesktopStatePath } from './paths.js';
import type { SessionDeckDesktopCommandResult } from './command.js';
import type { SessionDeckDesktopExecFile } from './install.js';

export interface OpenSessionDeckDesktopOptions {
  execFile?: SessionDeckDesktopExecFile;
  homeDirectory?: string;
  platform?: NodeJS.Platform;
  statePath?: string;
}

export async function openSessionDeckDesktop(
  options: OpenSessionDeckDesktopOptions = {},
): Promise<SessionDeckDesktopCommandResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    return {
      level: 'error',
      message: `Session Deck desktop open is only supported on macOS, not ${platform}.`,
    };
  }

  const homeDirectory = options.homeDirectory ?? homedir();
  const statePath = options.statePath ?? getSessionDeckDesktopStatePath(homeDirectory);
  const state = await readStateForOpen(statePath);
  if (state.status !== 'ok') {
    return state.result;
  }

  if (!(await pathIsDirectory(state.installState.app.path))) {
    return {
      level: 'error',
      message: [
        'Could not open Session Deck desktop app.',
        `Installed app is missing: ${state.installState.app.path}`,
        'Run /session-deck desktop doctor, or reinstall with /session-deck desktop install.',
      ].join('\n'),
    };
  }

  try {
    await execFilePromise(options.execFile ?? nodeExecFileAdapter, '/usr/bin/open', [
      state.installState.app.path,
    ]);
  } catch (error) {
    return {
      level: 'error',
      message: [
        'Could not open Session Deck desktop app.',
        `/usr/bin/open failed for ${state.installState.app.path}: ${getErrorMessage(error)}`,
      ].join('\n'),
    };
  }

  return {
    level: 'info',
    message: `Opened Session Deck desktop app: ${state.installState.app.path}`,
  };
}

async function readStateForOpen(
  statePath: string,
): Promise<
  | { status: 'ok'; installState: SessionDeckDesktopInstallState }
  | { status: 'error'; result: SessionDeckDesktopCommandResult }
> {
  try {
    const installState = await readSessionDeckDesktopInstallState(statePath);
    if (installState === null) {
      return {
        status: 'error',
        result: {
          level: 'warning',
          message: `Session Deck desktop app is not installed. Run /session-deck desktop install. State not found at ${statePath}.`,
        },
      };
    }
    return { status: 'ok', installState };
  } catch (error) {
    return {
      status: 'error',
      result: {
        level: 'error',
        message: [
          'Could not open Session Deck desktop app.',
          `Install state at ${statePath} could not be read: ${getErrorMessage(error)}`,
          'Run /session-deck desktop doctor or repair/remove the state file before opening.',
        ].join('\n'),
      },
    };
  }
}

async function execFilePromise(
  execFile: SessionDeckDesktopExecFile,
  file: string,
  args: string[],
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    execFile(file, args, (error) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolvePromise();
    });
  });
}

const nodeExecFileAdapter: SessionDeckDesktopExecFile = (file, args, callback) => {
  const child = nodeExecFile(file, args, (error) => callback(error));
  child.stdin?.end();
};

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
