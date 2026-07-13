import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const OPEN_COMMAND = '/usr/bin/open';
const execFile = promisify(execFileCallback);

export type TerminalRevealOpenResult =
  | { ok: true; reason: 'requested'; message: string }
  | {
      ok: false;
      reason: 'unsupported-platform' | 'open-failed';
      message: string;
    };

export type TerminalRevealExecFile = (file: string, args: readonly string[]) => Promise<unknown>;

export interface TerminalRevealOpenOptions {
  platform?: NodeJS.Platform;
  execFile?: TerminalRevealExecFile;
}

export async function openTerminalRevealUrl(
  revealUrl: string,
  options: TerminalRevealOpenOptions = {},
): Promise<TerminalRevealOpenResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') {
    return {
      ok: false,
      reason: 'unsupported-platform',
      message: 'iTerm2 focus requests are only supported on macOS.',
    };
  }

  const execFileImpl = options.execFile ?? defaultExecFile;
  try {
    await execFileImpl(OPEN_COMMAND, [revealUrl]);
  } catch (error) {
    return {
      ok: false,
      reason: 'open-failed',
      message: `Failed to request iTerm2 focus: ${getErrorMessage(error)}`,
    };
  }

  return {
    ok: true,
    reason: 'requested',
    message: 'Requested iTerm2 focus for selected session.',
  };
}

const defaultExecFile: TerminalRevealExecFile = async (file, args) => {
  await execFile(file, [...args]);
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}
