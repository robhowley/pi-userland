import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeSessionTerminalMetadata } from './metadata.js';
import type { SessionTerminalMetadata } from './types.js';

const TMUX_COMMAND = 'tmux';
const FIELD_SEPARATOR = '\u001f';
const DEFAULT_TMUX_TIMEOUT_MS = 500;
const execFile = promisify(execFileCallback);

export type TerminalCollectExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
) => Promise<{ stdout?: string | Buffer } | string | Buffer | unknown>;

export interface CollectSessionTerminalMetadataOptions {
  env?: NodeJS.ProcessEnv;
  execFile?: TerminalCollectExecFile;
  tmuxTimeoutMs?: number;
}

export async function collectSessionTerminalMetadata(
  options: CollectSessionTerminalMetadataOptions = {},
): Promise<SessionTerminalMetadata | undefined> {
  const env = options.env ?? process.env;
  const iterm2Terminal = collectIterm2TerminalMetadataFromEnv(env);
  const tmuxTerminal = await collectTmuxTerminalMetadataFromEnv(env, options);
  return tmuxTerminal ?? iterm2Terminal;
}

export function collectIterm2TerminalMetadataFromEnv(
  env: NodeJS.ProcessEnv,
): SessionTerminalMetadata | undefined {
  return normalizeSessionTerminalMetadata({
    kind: 'iterm2',
    sessionId: env['ITERM_SESSION_ID'],
    termProgram: env['TERM_PROGRAM'],
    lcTerminal: env['LC_TERMINAL'],
    lcTerminalVersion: env['LC_TERMINAL_VERSION'],
  });
}

async function collectTmuxTerminalMetadataFromEnv(
  env: NodeJS.ProcessEnv,
  options: CollectSessionTerminalMetadataOptions,
): Promise<SessionTerminalMetadata | undefined> {
  const targetPane = trimNonEmpty(env['TMUX_PANE']);
  const envSocketPath = parseTmuxSocketPath(env['TMUX']);
  if (targetPane === undefined || envSocketPath === undefined) {
    return undefined;
  }

  const execFileImpl = options.execFile ?? defaultExecFile;
  const timeout = options.tmuxTimeoutMs ?? DEFAULT_TMUX_TIMEOUT_MS;
  const tmuxPrefix = ['-S', envSocketPath] as const;

  try {
    const paneRows = await execTmux(
      execFileImpl,
      [...tmuxPrefix, 'list-panes', '-a', '-F', '#{pane_id}\t#{pane_dead}'],
      timeout,
    );
    if (!hasLivePane(paneRows, targetPane)) {
      return undefined;
    }

    const format = [
      '#{session_name}',
      '#{session_id}',
      '#{window_name}',
      '#{window_id}',
      '#{pane_id}',
      '#{window_index}',
      '#{pane_index}',
      '#{pane_pid}',
      '#{socket_path}',
    ].join(FIELD_SEPARATOR);
    const display = await execTmux(
      execFileImpl,
      [...tmuxPrefix, 'display-message', '-p', '-t', targetPane, format],
      timeout,
    );
    const fields = display.trimEnd().split(FIELD_SEPARATOR);
    const [
      sessionName,
      sessionId,
      windowName,
      windowId,
      paneId,
      windowIndex,
      paneIndex,
      panePid,
      displaySocketPath,
    ] = fields;

    if (trimNonEmpty(paneId) !== targetPane) {
      return undefined;
    }

    return normalizeSessionTerminalMetadata({
      kind: 'tmux',
      socketPath: trimNonEmpty(displaySocketPath) ?? envSocketPath,
      sessionName,
      sessionId,
      windowName,
      windowId,
      paneId,
      windowIndex,
      paneIndex,
      panePid,
    });
  } catch {
    return undefined;
  }
}

async function execTmux(
  execFileImpl: TerminalCollectExecFile,
  args: readonly string[],
  timeout: number,
): Promise<string> {
  const result = await execFileImpl(TMUX_COMMAND, args, { timeout });
  if (typeof result === 'string') {
    return result;
  }

  if (Buffer.isBuffer(result)) {
    return result.toString('utf8');
  }

  if (isObject(result)) {
    const stdout = result['stdout'];
    if (typeof stdout === 'string') {
      return stdout;
    }
    if (Buffer.isBuffer(stdout)) {
      return stdout.toString('utf8');
    }
  }

  return '';
}

function hasLivePane(source: string, targetPane: string): boolean {
  return source
    .split('\n')
    .map((line) => line.trimEnd())
    .some((line) => {
      const [paneId, paneDead] = line.split('\t');
      return paneId === targetPane && paneDead === '0';
    });
}

function parseTmuxSocketPath(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  return trimNonEmpty(value.split(',')[0]);
}

function trimNonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const defaultExecFile: TerminalCollectExecFile = async (file, args, options) => {
  const result = await execFile(file, [...args], options);
  return result as { stdout?: string | Buffer };
};

function isObject(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null;
}
