import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  SessionRuntimeInheritedDeckRuntimeMetadata,
  SessionRuntimeLaunchMetadata,
  SessionRuntimeLaunchMode,
  SessionRuntimeProcessAncestorMetadata,
  SessionRuntimeProcessMetadata,
  SessionRuntimeSignalsMetadata,
  SessionRuntimeStdioMetadata,
} from './types.js';

export const PI_SESSION_DECK_RUNTIME_ID_ENV = 'PI_SESSION_DECK_RUNTIME_ID';
export const PI_SESSION_DECK_SESSION_ID_ENV = 'PI_SESSION_DECK_SESSION_ID';
export const PI_SESSION_DECK_SESSION_FILE_ENV = 'PI_SESSION_DECK_SESSION_FILE';
export const PI_SESSION_DECK_RUNTIME_STARTED_AT_ENV = 'PI_SESSION_DECK_RUNTIME_STARTED_AT';

export const MAX_RUNTIME_SIGNAL_ANCESTOR_DEPTH = 8;
const DEFAULT_ANCESTOR_TIMEOUT_MS = 120;
const PS_COMMAND = 'ps';
const execFile = promisify(execFileCallback);

export type RuntimeSignalsExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
) => Promise<{ stdout?: string | Buffer } | string | Buffer | unknown>;

export interface RuntimeSignalsStdioLike {
  stdinTTY?: boolean;
  stdoutTTY?: boolean;
  stderrTTY?: boolean;
}

export interface CollectRuntimeSignalsMetadataOptions {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  stdio?: RuntimeSignalsStdioLike;
  pid?: number;
  ppid?: number;
  now?: () => Date;
  uptimeSeconds?: () => number;
  maxAncestorDepth?: number;
  ancestorTimeoutMs?: number;
  readAncestorChain?: RuntimeProcessAncestorChainReader;
  execFile?: RuntimeSignalsExecFile;
}

export interface CollectRuntimeProcessMetadataOptions {
  pid?: number;
  ppid?: number;
  now?: () => Date;
  uptimeSeconds?: () => number;
  maxAncestorDepth?: number;
  ancestorTimeoutMs?: number;
  readAncestorChain?: RuntimeProcessAncestorChainReader;
  execFile?: RuntimeSignalsExecFile;
}

export interface ReadRuntimeProcessAncestorChainOptions {
  ppid: number;
  maxDepth: number;
  timeoutMs: number;
  readProcessInfo?: RuntimeProcessInfoReader;
}

export type RuntimeProcessInfoReader = (
  pid: number,
  timeoutMs: number,
) => Promise<SessionRuntimeProcessAncestorMetadata | undefined>;

export type RuntimeProcessAncestorChainReader = (
  options: ReadRuntimeProcessAncestorChainOptions,
) => Promise<SessionRuntimeProcessAncestorMetadata[]>;

export interface PublishDeckRuntimeEnvOptions {
  env?: NodeJS.ProcessEnv;
  runtimeId?: string | null;
  sessionId?: string | null;
  sessionFile?: string | null;
  startedAt?: string | null;
}

export async function collectRuntimeSignalsMetadata(
  options: CollectRuntimeSignalsMetadataOptions = {},
): Promise<SessionRuntimeSignalsMetadata> {
  const processMetadata = await collectRuntimeProcessMetadata(options);
  const launch = collectRuntimeLaunchMetadataFromArgv(options.argv ?? process.argv);
  const stdio = collectRuntimeStdioMetadata(
    options.stdio ?? {
      stdinTTY: process.stdin?.isTTY,
      stdoutTTY: process.stdout?.isTTY,
      stderrTTY: process.stderr?.isTTY,
    },
  );
  const inheritedDeckRuntime = collectInheritedDeckRuntimeMetadataFromEnv(
    options.env ?? process.env,
  );

  return {
    ...(processMetadata === undefined ? {} : { process: processMetadata }),
    launch,
    stdio,
    ...(inheritedDeckRuntime === undefined ? {} : { inheritedDeckRuntime }),
  };
}

export async function collectRuntimeProcessMetadata(
  options: CollectRuntimeProcessMetadataOptions = {},
): Promise<SessionRuntimeProcessMetadata | undefined> {
  const pid = normalizePositiveInteger(options.pid ?? process.pid);
  if (pid === undefined) {
    return undefined;
  }

  const ppid = normalizePositiveInteger(options.ppid ?? process.ppid);
  const now = options.now ?? (() => new Date());
  const uptimeSeconds = options.uptimeSeconds ?? (() => process.uptime());
  const maxDepth = clampAncestorDepth(options.maxAncestorDepth);
  const timeoutMs =
    normalizePositiveInteger(options.ancestorTimeoutMs) ?? DEFAULT_ANCESTOR_TIMEOUT_MS;
  const processStartedAt = deriveCurrentProcessStartedAt(now, uptimeSeconds);

  let ancestors: SessionRuntimeProcessAncestorMetadata[] = [];
  if (ppid !== undefined && maxDepth > 0) {
    const readAncestorChain =
      options.readAncestorChain ??
      ((ancestorOptions: ReadRuntimeProcessAncestorChainOptions) =>
        readRuntimeProcessAncestorChain({
          ...ancestorOptions,
          readProcessInfo: createDefaultRuntimeProcessInfoReader(options.execFile),
        }));

    try {
      ancestors = (await readAncestorChain({ ppid, maxDepth, timeoutMs })).slice(0, maxDepth);
    } catch {
      ancestors = [];
    }
  }

  return {
    pid,
    ...(ppid === undefined ? {} : { ppid }),
    ...(processStartedAt === undefined ? {} : { processStartedAt }),
    ancestors,
  };
}

export function collectRuntimeLaunchMetadataFromArgv(
  argv: readonly string[],
): SessionRuntimeLaunchMetadata {
  const noSession = argvIncludesFlag(argv, '--no-session');
  const print = argvIncludesFlag(argv, '--print') || argv.includes('-p');
  const mode = parseRuntimeLaunchModeFromArgv(argv, print);

  return {
    noSession,
    print,
    ...(mode === undefined ? {} : { mode }),
    sessionArgPresent: argvIncludesValueFlag(argv, '--session'),
    forkArgPresent: argvIncludesValueFlag(argv, '--fork'),
  };
}

export function collectRuntimeStdioMetadata(
  stdio: RuntimeSignalsStdioLike,
): SessionRuntimeStdioMetadata {
  return {
    stdinTTY: stdio.stdinTTY === true,
    stdoutTTY: stdio.stdoutTTY === true,
    stderrTTY: stdio.stderrTTY === true,
  };
}

export function collectInheritedDeckRuntimeMetadataFromEnv(
  env: NodeJS.ProcessEnv,
): SessionRuntimeInheritedDeckRuntimeMetadata | undefined {
  const runtimeId = trimNonEmpty(env[PI_SESSION_DECK_RUNTIME_ID_ENV]);
  const sessionId = trimNonEmpty(env[PI_SESSION_DECK_SESSION_ID_ENV]);
  const sessionFile = trimNonEmpty(env[PI_SESSION_DECK_SESSION_FILE_ENV]);
  const startedAt = trimNonEmpty(env[PI_SESSION_DECK_RUNTIME_STARTED_AT_ENV]);

  return runtimeId === undefined &&
    sessionId === undefined &&
    sessionFile === undefined &&
    startedAt === undefined
    ? undefined
    : {
        ...(runtimeId === undefined ? {} : { runtimeId }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(sessionFile === undefined ? {} : { sessionFile }),
        ...(startedAt === undefined ? {} : { startedAt }),
      };
}

export async function readRuntimeProcessAncestorChain(
  options: ReadRuntimeProcessAncestorChainOptions,
): Promise<SessionRuntimeProcessAncestorMetadata[]> {
  const maxDepth = clampAncestorDepth(options.maxDepth);
  const ancestors: SessionRuntimeProcessAncestorMetadata[] = [];
  const seen = new Set<number>();
  let nextPid = normalizePositiveInteger(options.ppid);

  for (let depth = 0; depth < maxDepth && nextPid !== undefined; depth += 1) {
    if (seen.has(nextPid)) {
      break;
    }
    seen.add(nextPid);

    const info = await options.readProcessInfo?.(nextPid, options.timeoutMs);
    if (info === undefined || info.pid !== nextPid) {
      throw new Error('ancestor_unavailable');
    }

    ancestors.push(info);
    nextPid = normalizePositiveInteger(info.ppid);
  }

  return ancestors;
}

export function publishDeckRuntimeEnv(options: PublishDeckRuntimeEnvOptions): void {
  const env = options.env ?? process.env;
  setEnvValue(env, PI_SESSION_DECK_RUNTIME_ID_ENV, options.runtimeId);
  setEnvValue(env, PI_SESSION_DECK_SESSION_ID_ENV, options.sessionId);
  setEnvValue(env, PI_SESSION_DECK_SESSION_FILE_ENV, options.sessionFile);
  setEnvValue(env, PI_SESSION_DECK_RUNTIME_STARTED_AT_ENV, options.startedAt);
}

function parseRuntimeLaunchModeFromArgv(
  argv: readonly string[],
  printFlagPresent: boolean,
): SessionRuntimeLaunchMode | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--mode') {
      const parsed = normalizeRuntimeLaunchMode(argv[index + 1]);
      if (parsed !== undefined) {
        return parsed;
      }
      continue;
    }

    if (typeof token === 'string' && token.startsWith('--mode=')) {
      const parsed = normalizeRuntimeLaunchMode(token.slice('--mode='.length));
      if (parsed !== undefined) {
        return parsed;
      }
    }
  }

  return printFlagPresent ? 'print' : undefined;
}

function normalizeRuntimeLaunchMode(value: unknown): SessionRuntimeLaunchMode | undefined {
  switch (value) {
    case 'tui':
    case 'rpc':
    case 'json':
    case 'print':
      return value;
    default:
      return undefined;
  }
}

function argvIncludesFlag(argv: readonly string[], flag: string): boolean {
  return argv.some((token) => token === flag);
}

function argvIncludesValueFlag(argv: readonly string[], flag: string): boolean {
  return argv.some((token) => token === flag || token.startsWith(`${flag}=`));
}

function deriveCurrentProcessStartedAt(
  now: () => Date,
  uptimeSeconds: () => number,
): string | undefined {
  const nowMs = now().getTime();
  const uptime = uptimeSeconds();
  if (!Number.isFinite(nowMs) || !Number.isFinite(uptime) || uptime < 0) {
    return undefined;
  }

  return new Date(nowMs - uptime * 1000).toISOString();
}

function clampAncestorDepth(value: unknown): number {
  const parsed = normalizePositiveInteger(value);
  if (parsed === undefined) {
    return MAX_RUNTIME_SIGNAL_ANCESTOR_DEPTH;
  }

  return Math.min(parsed, MAX_RUNTIME_SIGNAL_ANCESTOR_DEPTH);
}

function createDefaultRuntimeProcessInfoReader(
  execFileImpl: RuntimeSignalsExecFile | undefined,
): RuntimeProcessInfoReader {
  const readWithPs = createPsRuntimeProcessInfoReader(execFileImpl);
  return async (pid, timeoutMs) => await readWithPs(pid, timeoutMs);
}

function createPsRuntimeProcessInfoReader(
  execFileImpl: RuntimeSignalsExecFile | undefined,
): RuntimeProcessInfoReader {
  const execImpl = execFileImpl ?? defaultExecFile;

  return async (pid: number, timeoutMs: number) => {
    const result = await execImpl(PS_COMMAND, ['-o', 'pid=,ppid=,lstart=', '-p', String(pid)], {
      timeout: timeoutMs,
    });
    const stdout = coerceStdout(result);
    const line = stdout
      .split('\n')
      .map((candidate) => candidate.trim())
      .find((candidate) => candidate.length > 0);

    if (line === undefined) {
      return undefined;
    }

    const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (match === null) {
      return undefined;
    }

    const ancestorPid = normalizePositiveInteger(match[1]);
    if (ancestorPid === undefined) {
      return undefined;
    }

    const ancestorPpid = normalizePositiveInteger(match[2]);
    const parsedStartedAt = parsePsStartedAt(match[3]);

    return {
      pid: ancestorPid,
      ...(ancestorPpid === undefined ? {} : { ppid: ancestorPpid }),
      ...(parsedStartedAt === undefined ? {} : { processStartedAt: parsedStartedAt }),
    };
  };
}

function parsePsStartedAt(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function coerceStdout(result: { stdout?: string | Buffer } | string | Buffer | unknown): string {
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

function setEnvValue(env: NodeJS.ProcessEnv, key: string, value: string | null | undefined): void {
  const normalized = trimNonEmpty(value);
  if (normalized === undefined) {
    delete env[key];
    return;
  }

  env[key] = normalized;
}

function trimNonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  return undefined;
}

const defaultExecFile: RuntimeSignalsExecFile = async (file, args, options) => {
  const result = await execFile(file, [...args], { ...options, encoding: 'utf8' });
  return result as { stdout?: string | Buffer };
};

function isObject(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null;
}
