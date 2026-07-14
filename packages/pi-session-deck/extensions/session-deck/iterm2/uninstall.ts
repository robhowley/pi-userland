import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { readSessionDeckIterm2InstallState, type SessionDeckIterm2InstallState } from './state.js';
import { getSessionDeckIterm2StatePath } from './paths.js';
import type { SessionDeckIterm2CommandResult } from './command.js';

export interface UninstallSessionDeckIterm2Options {
  homeDirectory?: string;
  statePath?: string;
}

export async function uninstallSessionDeckIterm2(
  options: UninstallSessionDeckIterm2Options = {},
): Promise<SessionDeckIterm2CommandResult> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const statePath = options.statePath ?? getSessionDeckIterm2StatePath(homeDirectory);
  let state: SessionDeckIterm2InstallState | null;
  try {
    state = await readSessionDeckIterm2InstallState(statePath);
  } catch (error) {
    return {
      level: 'warning',
      message: [
        'Could not uninstall Session Deck iTerm2 Toolbelt automatically.',
        `Install state at ${statePath} could not be read: ${getErrorMessage(error)}`,
        'Nothing was removed because script ownership could not be verified.',
        'Manual recovery required: remove or repair the state file and verify/remove any Session Deck AutoLaunch script manually.',
      ].join('\n'),
    };
  }

  if (state === null) {
    return {
      level: 'warning',
      message: `No Session Deck iTerm2 install state found at ${statePath}.`,
    };
  }

  await rm(state.script.path, { force: true });
  await rm(statePath, { force: true });

  return {
    level: 'info',
    message: [
      'Uninstalled Session Deck iTerm2 Toolbelt.',
      `Removed AutoLaunch script: ${state.script.path}`,
      `Removed state: ${statePath}`,
      'Restart iTerm2 to stop any already-running Session Deck iTerm2 process.',
    ].join('\n'),
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
