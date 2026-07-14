import { access, lstat, readFile } from 'node:fs/promises';
import net from 'node:net';
import { homedir } from 'node:os';
import {
  hashSessionDeckIterm2Content,
  readSessionDeckIterm2InstallState,
  type SessionDeckIterm2InstallState,
} from './state.js';
import {
  getSessionDeckIterm2ScriptPath,
  getSessionDeckIterm2StatePath,
  getSessionDeckIterm2WebAssetPaths,
  resolveSessionDeckIterm2RuntimePaths,
  type SessionDeckIterm2RuntimePaths,
} from './paths.js';
import type { SessionDeckIterm2CommandResult } from './command.js';

const DEFAULT_PING_TIMEOUT_MS = 500;

export type SessionDeckIterm2BridgeSocket = NodeJS.ReadWriteStream & {
  destroy?: () => void;
  setEncoding?: (encoding: BufferEncoding) => void;
};

export type SessionDeckIterm2BridgePingResult =
  | { status: 'live'; message: string }
  | { status: 'missing'; message: string }
  | { status: 'not-socket'; message: string }
  | { status: 'stale'; message: string };

export interface DoctorSessionDeckIterm2InstallOptions {
  homeDirectory?: string;
  pingBridge?: (socketPath: string) => Promise<SessionDeckIterm2BridgePingResult>;
  platform?: NodeJS.Platform;
  runtimePaths?: SessionDeckIterm2RuntimePaths;
  statePath?: string;
}

export async function doctorSessionDeckIterm2Install(
  options: DoctorSessionDeckIterm2InstallOptions = {},
): Promise<SessionDeckIterm2CommandResult> {
  const homeDirectory = options.homeDirectory ?? homedir();
  const statePath = options.statePath ?? getSessionDeckIterm2StatePath(homeDirectory);
  let state: SessionDeckIterm2InstallState | null = null;
  let stateReadError: string | null = null;
  try {
    state = await readSessionDeckIterm2InstallState(statePath);
  } catch (error) {
    stateReadError = getErrorMessage(error);
  }

  const lines = ['Session Deck iTerm2 doctor'];
  const issues: string[] = [];

  const platform = options.platform ?? process.platform;
  lines.push(`- platform: ${platform}`);
  if (platform !== 'darwin') {
    issues.push('iTerm2 Toolbelt support is macOS-only.');
  }

  lines.push(
    `- state: ${stateReadError === null ? (state === null ? 'missing' : statePath) : `invalid (${statePath})`}`,
  );

  if (stateReadError !== null) {
    issues.push(`Install state at ${statePath} could not be read: ${stateReadError}`);
    issues.push(
      'Manual recovery required: remove or repair the state file, verify/remove any Session Deck AutoLaunch script manually, then rerun /session-deck iterm2 install.',
    );
  } else if (state === null) {
    issues.push(`Install state not found at ${statePath}. Run /session-deck iterm2 install.`);
  } else {
    await checkInstalledState(state, lines, issues);
  }

  let runtimePaths: SessionDeckIterm2RuntimePaths | null = options.runtimePaths ?? null;
  if (runtimePaths === null) {
    try {
      runtimePaths = await resolveSessionDeckIterm2RuntimePaths(import.meta.url);
    } catch (error) {
      issues.push(`Could not resolve current package runtime paths: ${getErrorMessage(error)}`);
    }
  }

  if (runtimePaths !== null) {
    await checkRuntimePaths(runtimePaths, state, lines, issues);
  }

  if (state !== null) {
    const pingBridge = options.pingBridge ?? pingSessionDeckIterm2Bridge;
    const pingResult = await pingBridge(state.runtime.bridgeSocketPath);
    lines.push(`- bridge socket: ${state.runtime.bridgeSocketPath} (${pingResult.status})`);
    if (pingResult.status !== 'live') {
      issues.push(pingResult.message);
    }
  }

  lines.push(
    '- manual: enable iTerm2 Python API if needed, then restart iTerm2 after install changes.',
  );

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

export async function pingSessionDeckIterm2Bridge(
  socketPath: string,
  options: {
    clearTimeout?: typeof clearTimeout;
    createConnection?: (path: string) => SessionDeckIterm2BridgeSocket;
    setTimeout?: typeof setTimeout;
    timeoutMs?: number;
  } = {},
): Promise<SessionDeckIterm2BridgePingResult> {
  try {
    const socketStat = await lstat(socketPath);
    if (!socketStat.isSocket()) {
      return {
        status: 'not-socket',
        message: `Bridge socket path exists but is not a socket: ${socketPath}`,
      };
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        status: 'missing',
        message: `Bridge socket is missing: ${socketPath}`,
      };
    }
    return {
      status: 'stale',
      message: `Bridge socket could not be inspected: ${getErrorMessage(error)}`,
    };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
  const createConnection =
    options.createConnection ??
    ((path: string): SessionDeckIterm2BridgeSocket => net.createConnection(path));
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;

  return new Promise<SessionDeckIterm2BridgePingResult>((resolve) => {
    let socket: SessionDeckIterm2BridgeSocket;
    try {
      socket = createConnection(socketPath);
    } catch (error) {
      resolve({
        status: 'stale',
        message: `Bridge socket is not accepting connections: ${getErrorMessage(error)}`,
      });
      return;
    }

    let settled = false;
    let buffer = '';
    const finish = (result: SessionDeckIterm2BridgePingResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer(timeout);
      try {
        socket.end();
      } catch {
        // Best effort cleanup.
      }
      resolve(result);
    };

    const timeout = setTimer(() => {
      try {
        socket.destroy?.();
      } catch {
        // Best effort cleanup.
      }
      finish({
        status: 'stale',
        message: 'Bridge socket did not answer ping before the timeout.',
      });
    }, timeoutMs);

    socket.setEncoding?.('utf8');
    socket.on('connect', () => {
      try {
        socket.write(`${JSON.stringify({ ping: true })}\n`);
      } catch (error) {
        finish({
          status: 'stale',
          message: `Bridge socket could not receive ping: ${getErrorMessage(error)}`,
        });
      }
    });
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }
      finish(parsePingResponse(buffer.slice(0, newlineIndex)));
    });
    socket.on('error', (error) => {
      finish({
        status: 'stale',
        message: `Bridge socket is not accepting connections: ${getErrorMessage(error)}`,
      });
    });
    socket.on('close', () => {
      finish({
        status: 'stale',
        message: 'Bridge socket closed before answering ping.',
      });
    });
  });
}

async function checkInstalledState(
  state: SessionDeckIterm2InstallState,
  lines: string[],
  issues: string[],
): Promise<void> {
  const expectedScriptPath = getSessionDeckIterm2ScriptPath(state.scriptsDir);
  lines.push(`- scripts dir: ${state.scriptsDir}`);
  lines.push(
    `- AutoLaunch script: ${state.script.path}${(await pathExists(state.script.path)) ? '' : ' (missing)'}`,
  );

  if (state.script.path !== expectedScriptPath) {
    issues.push(
      `State script path ${state.script.path} does not match scripts dir AutoLaunch target ${expectedScriptPath}.`,
    );
  }

  if (await pathExists(state.script.path)) {
    const installedScript = await readFile(state.script.path);
    const installedHash = hashSessionDeckIterm2Content(installedScript);
    if (installedHash !== state.script.sha256) {
      issues.push(
        'Installed AutoLaunch script hash differs from recorded state. Reinstall recommended.',
      );
    }
  } else {
    issues.push(`Installed AutoLaunch script is missing: ${state.script.path}`);
  }
}

async function checkRuntimePaths(
  runtimePaths: SessionDeckIterm2RuntimePaths,
  state: SessionDeckIterm2InstallState | null,
  lines: string[],
  issues: string[],
): Promise<void> {
  lines.push(
    `- canonical source: ${runtimePaths.autolaunchSourcePath}${(await pathExists(runtimePaths.autolaunchSourcePath)) ? '' : ' (missing)'}`,
  );
  lines.push(
    `- snapshot helper: ${runtimePaths.snapshotHelperPath}${(await pathExists(runtimePaths.snapshotHelperPath)) ? '' : ' (missing)'}`,
  );
  lines.push(
    `- web root: ${runtimePaths.webRootPath}${(await pathExists(runtimePaths.webRootPath)) ? '' : ' (missing)'}`,
  );

  if (!(await pathExists(runtimePaths.autolaunchSourcePath))) {
    issues.push(`iTerm2 AutoLaunch source is missing: ${runtimePaths.autolaunchSourcePath}`);
  } else if (state !== null) {
    const sourceHash = hashSessionDeckIterm2Content(
      await readFile(runtimePaths.autolaunchSourcePath),
    );
    if (sourceHash !== state.script.sha256) {
      issues.push(
        'Canonical AutoLaunch source hash differs from recorded state. Reinstall recommended.',
      );
    }
  }

  if (!(await pathExists(runtimePaths.snapshotHelperPath))) {
    issues.push(`Snapshot helper is missing: ${runtimePaths.snapshotHelperPath}`);
  }

  if (!(await pathExists(runtimePaths.webRootPath))) {
    issues.push(`Web assets are missing: ${runtimePaths.webRootPath}`);
  } else {
    const webAssets = getSessionDeckIterm2WebAssetPaths(runtimePaths.webRootPath);
    const requiredAssets = [
      { label: 'Web index', path: webAssets.indexPath },
      { label: 'Web app', path: webAssets.appPath },
      { label: 'Web stylesheet', path: webAssets.stylePath },
    ];

    for (const asset of requiredAssets) {
      if (!(await pathExists(asset.path))) {
        issues.push(`${asset.label} is missing: ${asset.path}`);
      }
    }
  }

  if (state !== null) {
    if (state.packageVersion !== runtimePaths.packageVersion) {
      issues.push(
        `Installed state version ${state.packageVersion} does not match current package version ${runtimePaths.packageVersion}. Reinstall recommended.`,
      );
    }
    if (state.runtime.nodeExecutablePath !== runtimePaths.nodeExecutablePath) {
      issues.push('Node executable path changed since install. Reinstall recommended.');
    }
    if (state.runtime.snapshotHelperPath !== runtimePaths.snapshotHelperPath) {
      issues.push('Snapshot helper path changed since install. Reinstall recommended.');
    }
    if (state.runtime.webRootPath !== runtimePaths.webRootPath) {
      issues.push('Web asset path changed since install. Reinstall recommended.');
    }
    if (state.runtime.bridgeSocketPath !== runtimePaths.bridgeSocketPath) {
      issues.push('Bridge socket path changed since install. Reinstall recommended.');
    }
  }
}

function parsePingResponse(line: string): SessionDeckIterm2BridgePingResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    return {
      status: 'stale',
      message: `Bridge socket returned malformed ping JSON: ${getErrorMessage(error)}`,
    };
  }

  if (isRecord(parsed) && parsed['ok'] === true) {
    return { status: 'live', message: 'Bridge socket answered ping.' };
  }

  return {
    status: 'stale',
    message: 'Bridge socket returned an unhealthy ping response.',
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
