import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION, getAgentDir } from '@earendil-works/pi-coding-agent';
import { getErrorMessage } from '../internal.js';
import {
  captureWatchUiRuntimeSnapshot,
  removeWatchUiRuntimeSnapshotHandoff,
  writeWatchUiRuntimeSnapshotHandoff,
  type WatchUiRuntimeModel,
  type WatchUiRuntimeModelRegistry,
  type WatchUiThinkingLevel,
} from './runtime-snapshot.js';
import {
  createMergeReadyWatchUiUrl,
  fetchMergeReadyWatchUiHealth,
  type MergeReadyWatchUiHealth,
} from './supervisor-client.js';
import {
  acquireMergeReadyWatchUiStartupLock,
  ensureMergeReadyWatchUiToken,
  getMergeReadyWatchUiPaths,
  readMergeReadyWatchSupervisorInfo,
  readMergeReadyWatchUiToken,
  removeMergeReadyWatchSupervisorInfo,
  type MergeReadyWatchSupervisorInfo,
  type MergeReadyWatchUiPaths,
} from './supervisor-state.js';

export type LaunchMergeReadyWatchUIResult = {
  level: 'info' | 'warning' | 'error';
  message: string;
};

export type LaunchMergeReadyWatchUIOptions = {
  exec: (
    command: string,
    args: string[],
    options?: { cwd?: string; timeout?: number },
  ) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
  agentDir?: string;
  cwd: string;
  getThinkingLevel?: () => WatchUiThinkingLevel | undefined;
  model?: WatchUiRuntimeModel;
  modelRegistry?: WatchUiRuntimeModelRegistry;
  openBrowser?: boolean;
  sessionDir?: string;
  startupTimeoutMs?: number;
};

export type StopMergeReadyWatchUIOptions = Pick<
  LaunchMergeReadyWatchUIOptions,
  'agentDir' | 'sessionDir'
>;

export type MergeReadyWatchUiBrowserOpenResult =
  | {
      opened: true;
    }
  | {
      opened: false;
      message: string;
    };

export type LaunchMergeReadyWatchUIDependencies = {
  acquireStartupLock: typeof acquireMergeReadyWatchUiStartupLock;
  captureRuntimeSnapshot: typeof captureWatchUiRuntimeSnapshot;
  ensureToken: typeof ensureMergeReadyWatchUiToken;
  fetchHealth: typeof fetchMergeReadyWatchUiHealth;
  getPaths: typeof getMergeReadyWatchUiPaths;
  openBrowser: (options: {
    exec: LaunchMergeReadyWatchUIOptions['exec'];
    cwd: string;
    url: string;
  }) => Promise<MergeReadyWatchUiBrowserOpenResult>;
  readSupervisorInfo: typeof readMergeReadyWatchSupervisorInfo;
  readToken: typeof readMergeReadyWatchUiToken;
  removeRuntimeSnapshotHandoff: typeof removeWatchUiRuntimeSnapshotHandoff;
  removeSupervisorInfo: typeof removeMergeReadyWatchSupervisorInfo;
  sleep: (ms: number) => Promise<void>;
  spawnSupervisor: (options: {
    agentDir: string;
    defaultCwd: string;
    logFile: string;
    packageRoot: string;
    runtimeSnapshotPath: string;
    supervisorMainPath: string;
  }) => Promise<void>;
  stopSupervisor: (options: {
    info: MergeReadyWatchSupervisorInfo;
    fetchHealth: typeof fetchMergeReadyWatchUiHealth;
    sleep: (ms: number) => Promise<void>;
  }) => Promise<void>;
  writeRuntimeSnapshotHandoff: typeof writeWatchUiRuntimeSnapshotHandoff;
};

export type StopMergeReadyWatchUIDependencies = Pick<
  LaunchMergeReadyWatchUIDependencies,
  | 'fetchHealth'
  | 'getPaths'
  | 'readSupervisorInfo'
  | 'removeSupervisorInfo'
  | 'sleep'
  | 'stopSupervisor'
>;

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_HEALTH_POLL_INTERVAL_MS = 100;
const DEFAULT_SUPERVISOR_STOP_TIMEOUT_MS = 5_000;

export async function launchMergeReadyWatchUI(
  options: LaunchMergeReadyWatchUIOptions,
): Promise<LaunchMergeReadyWatchUIResult> {
  return launchMergeReadyWatchUIWithDependencies(options, {
    acquireStartupLock: acquireMergeReadyWatchUiStartupLock,
    captureRuntimeSnapshot: captureWatchUiRuntimeSnapshot,
    ensureToken: ensureMergeReadyWatchUiToken,
    fetchHealth: fetchMergeReadyWatchUiHealth,
    getPaths: getMergeReadyWatchUiPaths,
    openBrowser: openMergeReadyWatchUiInBrowser,
    readSupervisorInfo: readMergeReadyWatchSupervisorInfo,
    readToken: readMergeReadyWatchUiToken,
    removeRuntimeSnapshotHandoff: removeWatchUiRuntimeSnapshotHandoff,
    removeSupervisorInfo: removeMergeReadyWatchSupervisorInfo,
    sleep: delay,
    spawnSupervisor: spawnDetachedMergeReadyWatchUiSupervisor,
    stopSupervisor: stopMergeReadyWatchUiSupervisor,
    writeRuntimeSnapshotHandoff: writeWatchUiRuntimeSnapshotHandoff,
  });
}

export async function stopMergeReadyWatchUI(
  options: StopMergeReadyWatchUIOptions,
): Promise<LaunchMergeReadyWatchUIResult> {
  return stopMergeReadyWatchUIWithDependencies(options, {
    fetchHealth: fetchMergeReadyWatchUiHealth,
    getPaths: getMergeReadyWatchUiPaths,
    readSupervisorInfo: readMergeReadyWatchSupervisorInfo,
    removeSupervisorInfo: removeMergeReadyWatchSupervisorInfo,
    sleep: delay,
    stopSupervisor: stopMergeReadyWatchUiSupervisor,
  });
}

export async function stopMergeReadyWatchUIWithDependencies(
  options: StopMergeReadyWatchUIOptions,
  dependencies: StopMergeReadyWatchUIDependencies,
): Promise<LaunchMergeReadyWatchUIResult> {
  const agentDir = resolveMergeReadyWatchUiAgentDir(options) ?? getAgentDir();
  const paths = dependencies.getPaths(agentDir);

  try {
    const info = await dependencies.readSupervisorInfo(paths);
    if (!info) {
      return {
        level: 'info',
        message: 'Merge-ready watch UI is not running.',
      };
    }

    const health = await dependencies.fetchHealth(info.port);
    if (!health) {
      await dependencies.removeSupervisorInfo(paths).catch(() => undefined);
      return {
        level: 'warning',
        message: 'Merge-ready watch UI is not responding. Cleared stale supervisor state.',
      };
    }

    await dependencies.stopSupervisor({
      info: normalizeHealthySupervisorInfo(info, health),
      fetchHealth: dependencies.fetchHealth,
      sleep: dependencies.sleep,
    });
    await dependencies.removeSupervisorInfo(paths).catch(() => undefined);

    return {
      level: 'info',
      message: 'Stopped merge-ready watch UI.',
    };
  } catch (error) {
    return {
      level: 'error',
      message: `Failed to stop merge-ready watch UI: ${getErrorMessage(error)}`,
    };
  }
}

export async function launchMergeReadyWatchUIWithDependencies(
  options: LaunchMergeReadyWatchUIOptions,
  dependencies: LaunchMergeReadyWatchUIDependencies,
): Promise<LaunchMergeReadyWatchUIResult> {
  const agentDir = resolveMergeReadyWatchUiAgentDir(options) ?? getAgentDir();
  const paths = dependencies.getPaths(agentDir);
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

  try {
    const snapshot = await dependencies.captureRuntimeSnapshot({
      agentDir,
      defaultCwd: options.cwd,
      ...(options.getThinkingLevel === undefined
        ? {}
        : { getThinkingLevel: options.getThinkingLevel }),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.modelRegistry === undefined ? {} : { modelRegistry: options.modelRegistry }),
      sdkVersion: VERSION,
    });

    const existingSupervisor = await readHealthySupervisorInfo(paths, dependencies);
    if (canReuseSupervisor(existingSupervisor, snapshot.signature)) {
      return openOrReportMergeReadyWatchUi({
        cwd: options.cwd,
        exec: options.exec,
        info: existingSupervisor,
        openBrowser: options.openBrowser ?? true,
        openBrowserWithDependencies: dependencies.openBrowser,
        paths,
        readToken: dependencies.readToken,
        reused: true,
      });
    }

    const releaseLock = await dependencies.acquireStartupLock(paths, {
      timeoutMs: startupTimeoutMs,
    });

    let runtimeSnapshotPath: string | undefined;

    try {
      const healthyDuringLock = await readHealthySupervisorInfo(paths, dependencies);
      if (canReuseSupervisor(healthyDuringLock, snapshot.signature)) {
        return openOrReportMergeReadyWatchUi({
          cwd: options.cwd,
          exec: options.exec,
          info: healthyDuringLock,
          openBrowser: options.openBrowser ?? true,
          openBrowserWithDependencies: dependencies.openBrowser,
          paths,
          readToken: dependencies.readToken,
          reused: true,
        });
      }

      if (healthyDuringLock) {
        await dependencies.stopSupervisor({
          info: healthyDuringLock,
          fetchHealth: dependencies.fetchHealth,
          sleep: dependencies.sleep,
        });
      }

      const packageRoot = resolveMergeReadyWatchUiPackageRoot();
      const supervisorMainPath = resolveMergeReadyWatchUiSupervisorMainPath();
      await access(supervisorMainPath);
      await dependencies.ensureToken(paths);
      runtimeSnapshotPath = await dependencies.writeRuntimeSnapshotHandoff(paths, snapshot);
      await dependencies.spawnSupervisor({
        agentDir,
        defaultCwd: snapshot.defaultCwd,
        logFile: paths.logFile,
        packageRoot,
        runtimeSnapshotPath,
        supervisorMainPath,
      });

      const launchedSupervisor = await waitForHealthySupervisor(
        paths,
        dependencies,
        startupTimeoutMs,
        snapshot.signature,
      );
      runtimeSnapshotPath = undefined;
      return openOrReportMergeReadyWatchUi({
        cwd: options.cwd,
        exec: options.exec,
        info: launchedSupervisor,
        openBrowser: options.openBrowser ?? true,
        openBrowserWithDependencies: dependencies.openBrowser,
        paths,
        readToken: dependencies.readToken,
        reused: false,
      });
    } finally {
      if (runtimeSnapshotPath) {
        await dependencies.removeRuntimeSnapshotHandoff(runtimeSnapshotPath).catch(() => undefined);
      }
      await releaseLock();
    }
  } catch (error) {
    return {
      level: 'error',
      message: `Failed to launch merge-ready watch UI: ${getErrorMessage(error)}`,
    };
  }
}

export function createMergeReadyWatchUiOpenCommand(
  url: string,
  platform = process.platform,
): {
  command: string;
  args: string[];
} | null {
  if (platform === 'darwin') {
    return { command: 'open', args: [url] };
  }

  if (platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'start', '', url] };
  }

  if (platform === 'linux') {
    return { command: 'xdg-open', args: [url] };
  }

  return null;
}

export async function openMergeReadyWatchUiInBrowser(options: {
  exec: LaunchMergeReadyWatchUIOptions['exec'];
  cwd: string;
  url: string;
  platform?: NodeJS.Platform;
}): Promise<MergeReadyWatchUiBrowserOpenResult> {
  const command = createMergeReadyWatchUiOpenCommand(options.url, options.platform);
  if (!command) {
    return {
      opened: false,
      message: `unsupported platform ${options.platform ?? process.platform}`,
    };
  }

  try {
    const result = await options.exec(command.command, command.args, {
      cwd: options.cwd,
      timeout: 10_000,
    });
    if (result.killed || result.code !== 0) {
      const output = `${result.stderr}\n${result.stdout}`.trim();
      return {
        opened: false,
        message:
          output.length > 0
            ? `browser open command exited with code ${String(result.code)}: ${output}`
            : `browser open command exited with code ${String(result.code)}`,
      };
    }

    return { opened: true };
  } catch (error) {
    return {
      opened: false,
      message: getErrorMessage(error),
    };
  }
}

export async function spawnDetachedMergeReadyWatchUiSupervisor(options: {
  agentDir: string;
  defaultCwd: string;
  logFile: string;
  packageRoot: string;
  runtimeSnapshotPath: string;
  supervisorMainPath: string;
}): Promise<void> {
  const logFd = openSync(options.logFile, 'a');

  try {
    const child = spawn(
      process.execPath,
      [
        options.supervisorMainPath,
        '--cwd',
        options.defaultCwd,
        '--agent-dir',
        options.agentDir,
        '--runtime-snapshot',
        options.runtimeSnapshotPath,
      ],
      {
        cwd: options.packageRoot,
        detached: true,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: options.agentDir,
        },
        stdio: ['ignore', logFd, logFd],
      },
    );

    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => resolve());
    });

    child.unref();
  } finally {
    closeSync(logFd);
  }
}

export function resolveMergeReadyWatchUiAgentDir(
  options: Pick<LaunchMergeReadyWatchUIOptions, 'agentDir' | 'sessionDir'>,
): string | undefined {
  const explicitAgentDir = options.agentDir?.trim();
  if (explicitAgentDir) {
    return path.resolve(explicitAgentDir);
  }

  const sessionDir = options.sessionDir?.trim();
  if (!sessionDir) {
    return undefined;
  }

  const resolvedSessionDir = path.resolve(sessionDir);
  const sessionsDir = path.dirname(resolvedSessionDir);
  if (path.basename(sessionsDir) !== 'sessions') {
    return undefined;
  }

  return path.dirname(sessionsDir);
}

export function resolveMergeReadyWatchUiPackageRoot(fromFileUrl = import.meta.url): string {
  const filePath = fileURLToPath(fromFileUrl);
  const threeLevelsUp = path.resolve(path.dirname(filePath), '../../..');
  return path.basename(threeLevelsUp) === 'dist' ? path.dirname(threeLevelsUp) : threeLevelsUp;
}

export function resolveMergeReadyWatchUiSupervisorMainPath(fromFileUrl = import.meta.url): string {
  return path.join(
    resolveMergeReadyWatchUiPackageRoot(fromFileUrl),
    'dist',
    'extensions',
    'merge-ready',
    'watch-ui',
    'supervisor-main.js',
  );
}

export async function stopMergeReadyWatchUiSupervisor(options: {
  info: MergeReadyWatchSupervisorInfo;
  fetchHealth: typeof fetchMergeReadyWatchUiHealth;
  sleep: (ms: number) => Promise<void>;
  timeoutMs?: number;
}): Promise<void> {
  if (options.info.pid <= 0) {
    return;
  }

  try {
    process.kill(options.info.pid, 'SIGTERM');
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ESRCH')) {
      return;
    }
    throw error;
  }

  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_SUPERVISOR_STOP_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const health = await options.fetchHealth(options.info.port);
    if (!health || health.pid !== options.info.pid) {
      return;
    }

    await options.sleep(DEFAULT_HEALTH_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out stopping existing merge-ready watch UI supervisor ${String(options.info.pid)}.`,
  );
}

async function openOrReportMergeReadyWatchUi(options: {
  cwd: string;
  exec: LaunchMergeReadyWatchUIOptions['exec'];
  info: MergeReadyWatchSupervisorInfo;
  openBrowser: boolean;
  openBrowserWithDependencies: LaunchMergeReadyWatchUIDependencies['openBrowser'];
  paths: MergeReadyWatchUiPaths;
  readToken: typeof readMergeReadyWatchUiToken;
  reused: boolean;
}): Promise<LaunchMergeReadyWatchUIResult> {
  const token = await options.readToken(options.paths);
  if (!token) {
    return {
      level: 'error',
      message: 'Merge-ready watch UI is running, but the API token file is missing.',
    };
  }

  const url = createMergeReadyWatchUiUrl(options.info.port, token, options.cwd);
  if (!options.openBrowser) {
    return {
      level: 'info',
      message: `${options.reused ? 'Merge-ready watch UI is already running' : 'Merge-ready watch UI launched'}: ${url}`,
    };
  }

  const browserResult = await options.openBrowserWithDependencies({
    exec: options.exec,
    cwd: options.cwd,
    url,
  });

  if (!browserResult.opened) {
    return {
      level: 'warning',
      message: `${options.reused ? 'Merge-ready watch UI is already running' : 'Merge-ready watch UI launched'}, but automatic browser open failed (${browserResult.message}). Visit ${url}`,
    };
  }

  return {
    level: 'info',
    message: `${options.reused ? 'Reused merge-ready watch UI' : 'Opened merge-ready watch UI'}: ${url}`,
  };
}

async function readHealthySupervisorInfo(
  paths: MergeReadyWatchUiPaths,
  dependencies: Pick<LaunchMergeReadyWatchUIDependencies, 'fetchHealth' | 'readSupervisorInfo'>,
): Promise<MergeReadyWatchSupervisorInfo | null> {
  const info = await dependencies.readSupervisorInfo(paths);
  if (!info) {
    return null;
  }

  const health = await dependencies.fetchHealth(info.port);
  if (!health) {
    return null;
  }

  return normalizeHealthySupervisorInfo(info, health);
}

function normalizeHealthySupervisorInfo(
  info: MergeReadyWatchSupervisorInfo,
  health: MergeReadyWatchUiHealth,
): MergeReadyWatchSupervisorInfo {
  return {
    ...info,
    pid: health.pid,
    port: health.port,
    startedAt: health.startedAt,
    packageVersion: health.packageVersion,
    snapshotLoaded: health.snapshotLoaded,
    snapshotSignature: health.snapshotSignature,
  };
}

function canReuseSupervisor(
  info: MergeReadyWatchSupervisorInfo | null,
  expectedSignature: string,
): info is MergeReadyWatchSupervisorInfo {
  return (
    info !== null && info.snapshotLoaded === true && info.snapshotSignature === expectedSignature
  );
}

async function waitForHealthySupervisor(
  paths: MergeReadyWatchUiPaths,
  dependencies: Pick<
    LaunchMergeReadyWatchUIDependencies,
    'fetchHealth' | 'readSupervisorInfo' | 'sleep'
  >,
  timeoutMs: number,
  expectedSignature: string,
): Promise<MergeReadyWatchSupervisorInfo> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const healthy = await readHealthySupervisorInfo(paths, dependencies);
    if (canReuseSupervisor(healthy, expectedSignature)) {
      return healthy;
    }

    await dependencies.sleep(DEFAULT_HEALTH_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Timed out waiting for merge-ready watch UI supervisor startup with runtime signature ${expectedSignature}. See ${paths.logFile}`,
  );
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    timeout.unref?.();
  });
}
