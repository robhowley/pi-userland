import { constants } from 'node:fs';
import { access, lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
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
import {
  sendJsonLineSocketRequest,
  type JsonLineSocketClientSocket,
} from './json-line-socket-client.js';

const DEFAULT_PING_TIMEOUT_MS = 500;
const LOCAL_PATH_PROVENANCE = 'local Pi doctor process PATH';
const LIVE_PATH_PROVENANCE = 'live Toolbelt AutoLaunch PATH';

export type SessionDeckIterm2BridgeSocket = JsonLineSocketClientSocket;

export type SessionDeckIterm2BridgePingResult =
  | { status: 'live'; message: string }
  | { status: 'missing'; message: string }
  | { status: 'not-socket'; message: string }
  | { status: 'stale'; message: string };

export interface SessionDeckIterm2ExecutableStatus {
  status: 'available' | 'missing' | 'unknown';
  path?: string;
  message?: string;
}

export interface SessionDeckIterm2LaunchPrereqReport {
  pathProvenance: string;
  tmux: SessionDeckIterm2ExecutableStatus;
  pi: SessionDeckIterm2ExecutableStatus;
}

export type SessionDeckIterm2LiveLaunchPrereqResult =
  | {
      status: 'live';
      report: SessionDeckIterm2LaunchPrereqReport;
    }
  | {
      status: 'unavailable';
      message: string;
    };

export interface DoctorSessionDeckIterm2InstallOptions {
  homeDirectory?: string;
  pingBridge?: (socketPath: string) => Promise<SessionDeckIterm2BridgePingResult>;
  platform?: NodeJS.Platform;
  readLiveLaunchPrereqs?: (socketPath: string) => Promise<SessionDeckIterm2LiveLaunchPrereqResult>;
  resolveExecutable?: (command: 'tmux' | 'pi') => Promise<SessionDeckIterm2ExecutableStatus>;
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

  const resolveExecutable = options.resolveExecutable ?? resolveExecutableOnPath;
  const localLaunchPrereqs = await collectLaunchPrereqReport(
    LOCAL_PATH_PROVENANCE,
    resolveExecutable,
  );
  appendLaunchPrereqReport(lines, localLaunchPrereqs);

  let liveLaunchPrereqs: SessionDeckIterm2LiveLaunchPrereqResult | null = null;
  if (state !== null) {
    const pingBridge = options.pingBridge ?? pingSessionDeckIterm2Bridge;
    const pingResult = await pingBridge(state.runtime.bridgeSocketPath);
    lines.push(`- bridge socket: ${state.runtime.bridgeSocketPath} (${pingResult.status})`);
    if (pingResult.status !== 'live') {
      issues.push(pingResult.message);
    } else {
      const readLiveLaunchPrereqs =
        options.readLiveLaunchPrereqs ?? readSessionDeckIterm2LiveLaunchPrereqs;
      liveLaunchPrereqs = await readLiveLaunchPrereqs(state.runtime.bridgeSocketPath);
      if (liveLaunchPrereqs.status === 'live') {
        appendLaunchPrereqReport(lines, liveLaunchPrereqs.report);
        addLiveLaunchPrereqIssues(liveLaunchPrereqs.report, issues);
      } else {
        issues.push(liveLaunchPrereqs.message);
      }
    }
  }

  if (liveLaunchPrereqs?.status !== 'live') {
    lines.push(`- launch prerequisites (${LIVE_PATH_PROVENANCE}): unavailable`);
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

  const result = await sendJsonLineSocketRequest(
    socketPath,
    { ping: true },
    {
      clearTimeout: options.clearTimeout,
      createConnection: options.createConnection,
      setTimeout: options.setTimeout,
      timeoutMs: options.timeoutMs ?? DEFAULT_PING_TIMEOUT_MS,
    },
  );

  switch (result.status) {
    case 'line':
      return parsePingResponse(result.line);
    case 'connect-error':
    case 'socket-error':
      return {
        status: 'stale',
        message: `Bridge socket is not accepting connections: ${getErrorMessage(result.error)}`,
      };
    case 'send-error':
      return {
        status: 'stale',
        message: `Bridge socket could not receive ping: ${getErrorMessage(result.error)}`,
      };
    case 'timeout':
      return {
        status: 'stale',
        message: 'Bridge socket did not answer ping before the timeout.',
      };
    case 'closed':
      return {
        status: 'stale',
        message: 'Bridge socket closed before answering ping.',
      };
  }
}

export async function readSessionDeckIterm2LiveLaunchPrereqs(
  socketPath: string,
  options: {
    clearTimeout?: typeof clearTimeout;
    createConnection?: (path: string) => SessionDeckIterm2BridgeSocket;
    setTimeout?: typeof setTimeout;
    timeoutMs?: number;
  } = {},
): Promise<SessionDeckIterm2LiveLaunchPrereqResult> {
  const result = await sendJsonLineSocketRequest(
    socketPath,
    { launchPrereqs: true },
    {
      clearTimeout: options.clearTimeout,
      createConnection: options.createConnection,
      setTimeout: options.setTimeout,
      timeoutMs: options.timeoutMs ?? DEFAULT_PING_TIMEOUT_MS,
    },
  );

  switch (result.status) {
    case 'line':
      return parseLiveLaunchPrereqResponse(result.line);
    case 'connect-error':
    case 'socket-error':
      return {
        status: 'unavailable',
        message: `${LIVE_PATH_PROVENANCE} could not be queried: ${getErrorMessage(result.error)}`,
      };
    case 'send-error':
      return {
        status: 'unavailable',
        message: `${LIVE_PATH_PROVENANCE} could not receive the launch prerequisite query: ${getErrorMessage(result.error)}`,
      };
    case 'timeout':
      return {
        status: 'unavailable',
        message: `${LIVE_PATH_PROVENANCE} did not answer the launch prerequisite query before the timeout.`,
      };
    case 'closed':
      return {
        status: 'unavailable',
        message: `${LIVE_PATH_PROVENANCE} closed the launch prerequisite query before answering.`,
      };
  }
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
    `- create-worktree helper: ${runtimePaths.createWorktreeHelperScriptPath}${(await pathExists(runtimePaths.createWorktreeHelperScriptPath)) ? '' : ' (missing)'}`,
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

  if (!(await pathExists(runtimePaths.createWorktreeHelperScriptPath))) {
    issues.push(
      `Create-worktree helper is missing: ${runtimePaths.createWorktreeHelperScriptPath}`,
    );
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

async function collectLaunchPrereqReport(
  pathProvenance: string,
  resolveExecutable: (command: 'tmux' | 'pi') => Promise<SessionDeckIterm2ExecutableStatus>,
): Promise<SessionDeckIterm2LaunchPrereqReport> {
  const [tmux, pi] = await Promise.all([resolveExecutable('tmux'), resolveExecutable('pi')]);
  return {
    pathProvenance,
    tmux,
    pi,
  };
}

function appendLaunchPrereqReport(
  lines: string[],
  report: SessionDeckIterm2LaunchPrereqReport,
): void {
  lines.push(`- launch prerequisites (${report.pathProvenance}):`);
  lines.push(`  - tmux: ${formatExecutableStatus(report.tmux)}`);
  lines.push(`  - pi: ${formatExecutableStatus(report.pi)}`);
}

function addLiveLaunchPrereqIssues(
  report: SessionDeckIterm2LaunchPrereqReport,
  issues: string[],
): void {
  for (const [command, status] of [
    ['tmux', report.tmux],
    ['pi', report.pi],
  ] as const) {
    if (status.status === 'available') {
      continue;
    }

    if (status.status === 'missing') {
      issues.push(
        `Live Toolbelt AutoLaunch PATH is missing ${command}. + New requires ${command} on PATH.`,
      );
      continue;
    }

    issues.push(
      `Could not determine ${command} status in live Toolbelt AutoLaunch PATH: ${status.message ?? 'unknown error'}`,
    );
  }
}

function formatExecutableStatus(status: SessionDeckIterm2ExecutableStatus): string {
  switch (status.status) {
    case 'available':
      return status.path === undefined ? 'available' : `available (${status.path})`;
    case 'missing':
      return 'missing';
    case 'unknown':
      return status.message === undefined ? 'unknown' : `unknown (${status.message})`;
  }
}

async function resolveExecutableOnPath(
  command: 'tmux' | 'pi',
): Promise<SessionDeckIterm2ExecutableStatus> {
  const pathValue = process.env['PATH'];
  if (typeof pathValue !== 'string' || pathValue.trim().length === 0) {
    return { status: 'unknown', message: 'PATH is empty.' };
  }

  for (const directory of pathValue.split(delimiter)) {
    const trimmedDirectory = directory.trim();
    if (trimmedDirectory.length === 0) {
      continue;
    }

    const candidatePath = join(trimmedDirectory, command);
    try {
      await access(candidatePath, constants.X_OK);
      return { status: 'available', path: candidatePath };
    } catch {
      continue;
    }
  }

  return { status: 'missing' };
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

function parseLiveLaunchPrereqResponse(line: string): SessionDeckIterm2LiveLaunchPrereqResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch (error) {
    return {
      status: 'unavailable',
      message: `${LIVE_PATH_PROVENANCE} returned malformed launch prerequisite JSON: ${getErrorMessage(error)}`,
    };
  }

  if (!isRecord(parsed) || parsed['ok'] !== true) {
    return {
      status: 'unavailable',
      message: `${LIVE_PATH_PROVENANCE} returned an unhealthy launch prerequisite response.`,
    };
  }

  const report = parseLaunchPrereqReport(parsed['launchPrereqs']);
  if (report === null) {
    return {
      status: 'unavailable',
      message: `${LIVE_PATH_PROVENANCE} returned an invalid launch prerequisite response.`,
    };
  }

  return { status: 'live', report };
}

function parseLaunchPrereqReport(candidate: unknown): SessionDeckIterm2LaunchPrereqReport | null {
  if (!isRecord(candidate) || typeof candidate['pathProvenance'] !== 'string') {
    return null;
  }

  const tmux = parseExecutableStatus(candidate['tmux']);
  const pi = parseExecutableStatus(candidate['pi']);
  if (tmux === null || pi === null) {
    return null;
  }

  return {
    pathProvenance: candidate['pathProvenance'],
    tmux,
    pi,
  };
}

function parseExecutableStatus(candidate: unknown): SessionDeckIterm2ExecutableStatus | null {
  if (!isRecord(candidate)) {
    return null;
  }

  const status = candidate['status'];
  if (status !== 'available' && status !== 'missing' && status !== 'unknown') {
    return null;
  }

  const path = candidate['path'];
  const message = candidate['message'];
  if (path !== undefined && typeof path !== 'string') {
    return null;
  }
  if (message !== undefined && typeof message !== 'string') {
    return null;
  }

  return {
    status,
    ...(typeof path === 'string' ? { path } : {}),
    ...(typeof message === 'string' ? { message } : {}),
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
