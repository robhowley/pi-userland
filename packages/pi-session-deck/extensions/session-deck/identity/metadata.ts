import type {
  SessionHeaderMetadata,
  SessionRuntimeInheritedDeckRuntimeMetadata,
  SessionRuntimeLaunchMetadata,
  SessionRuntimeLaunchMode,
  SessionRuntimeProcessAncestorMetadata,
  SessionRuntimeProcessMetadata,
  SessionRuntimeSignalsMetadata,
  SessionRuntimeStdioMetadata,
  SessionStartMetadata,
  SessionTerminalMetadata,
} from './types.js';

export function normalizeSessionStartMetadata(
  candidate: unknown,
): SessionStartMetadata | undefined {
  if (!isObject(candidate)) {
    return undefined;
  }

  const reason = normalizeOptionalStringField(candidate['reason']);
  if (reason === undefined) {
    return undefined;
  }

  const previousSessionFile = normalizeOptionalStringField(candidate['previousSessionFile']);
  const mode = normalizeOptionalStringField(candidate['mode']);
  const hasUI = normalizeBooleanField(candidate['hasUI']);

  return {
    reason,
    ...(previousSessionFile === undefined ? {} : { previousSessionFile }),
    ...(mode === undefined ? {} : { mode }),
    ...(hasUI === undefined ? {} : { hasUI }),
  };
}

export function normalizeSessionHeaderMetadata(
  candidate: unknown,
): SessionHeaderMetadata | undefined {
  if (!isObject(candidate)) {
    return undefined;
  }

  const id = normalizeOptionalStringField(candidate['id']);
  const timestamp = normalizeOptionalStringField(candidate['timestamp']);
  const cwd = normalizeOptionalStringField(candidate['cwd']);
  if (id === undefined || timestamp === undefined || cwd === undefined) {
    return undefined;
  }

  const parentSession = normalizeOptionalStringField(candidate['parentSession']);
  return {
    id,
    timestamp,
    cwd,
    ...(parentSession === undefined ? {} : { parentSession }),
  };
}

export function normalizeSessionTerminalMetadata(
  candidate: unknown,
): SessionTerminalMetadata | undefined {
  if (!isObject(candidate)) {
    return undefined;
  }

  switch (candidate['kind']) {
    case 'iterm2':
      return normalizeIterm2TerminalMetadata(candidate);
    case 'tmux':
      return normalizeTmuxTerminalMetadata(candidate);
    default:
      return undefined;
  }
}

export function normalizeSessionRuntimeSignalsMetadata(
  candidate: unknown,
): SessionRuntimeSignalsMetadata | undefined {
  if (!isObject(candidate)) {
    return undefined;
  }

  const process = normalizeSessionRuntimeProcessMetadata(candidate['process']);
  const launch = normalizeSessionRuntimeLaunchMetadata(candidate['launch']);
  const stdio = normalizeSessionRuntimeStdioMetadata(candidate['stdio']);
  const inheritedDeckRuntime = normalizeSessionRuntimeInheritedDeckRuntimeMetadata(
    candidate['inheritedDeckRuntime'],
  );

  return process === undefined &&
    launch === undefined &&
    stdio === undefined &&
    inheritedDeckRuntime === undefined
    ? undefined
    : {
        ...(process === undefined ? {} : { process }),
        ...(launch === undefined ? {} : { launch }),
        ...(stdio === undefined ? {} : { stdio }),
        ...(inheritedDeckRuntime === undefined ? {} : { inheritedDeckRuntime }),
      };
}

function normalizeIterm2TerminalMetadata(
  candidate: Record<string, unknown>,
): SessionTerminalMetadata | undefined {
  const sessionId = normalizeTrimmedStringField(candidate['sessionId']);
  if (sessionId === undefined) {
    return undefined;
  }

  const termProgram = normalizeTrimmedStringField(candidate['termProgram']);
  const lcTerminal = normalizeTrimmedStringField(candidate['lcTerminal']);
  const lcTerminalVersion = normalizeTrimmedStringField(candidate['lcTerminalVersion']);

  return {
    kind: 'iterm2',
    sessionId,
    revealUrl: `iterm2:///reveal?sessionid=${encodeURIComponent(sessionId)}`,
    ...(termProgram === undefined ? {} : { termProgram }),
    ...(lcTerminal === undefined ? {} : { lcTerminal }),
    ...(lcTerminalVersion === undefined ? {} : { lcTerminalVersion }),
  };
}

function normalizeTmuxTerminalMetadata(
  candidate: Record<string, unknown>,
): SessionTerminalMetadata | undefined {
  const sessionName = normalizeTrimmedStringField(candidate['sessionName']);
  if (sessionName === undefined) {
    return undefined;
  }

  const socketPath = normalizeTrimmedStringField(candidate['socketPath']);
  const socketName = normalizeTmuxSocketName(candidate['socketName']);
  if (socketPath === undefined && socketName === undefined) {
    return undefined;
  }

  const sessionId = normalizeTrimmedStringField(candidate['sessionId']);
  const windowName = normalizeTrimmedStringField(candidate['windowName']);
  const windowId = normalizeTrimmedStringField(candidate['windowId']);
  const paneId = normalizeTrimmedStringField(candidate['paneId']);
  const windowIndex = normalizeNonNegativeIntegerField(candidate['windowIndex']);
  const paneIndex = normalizeNonNegativeIntegerField(candidate['paneIndex']);
  const panePid = normalizeNonNegativeIntegerField(candidate['panePid']);

  return {
    kind: 'tmux',
    sessionName,
    ...(socketPath === undefined ? {} : { socketPath }),
    ...(socketPath !== undefined || socketName === undefined ? {} : { socketName }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(windowName === undefined ? {} : { windowName }),
    ...(windowId === undefined ? {} : { windowId }),
    ...(paneId === undefined ? {} : { paneId }),
    ...(windowIndex === undefined ? {} : { windowIndex }),
    ...(paneIndex === undefined ? {} : { paneIndex }),
    ...(panePid === undefined ? {} : { panePid }),
  };
}

function normalizeSessionRuntimeProcessMetadata(
  candidate: unknown,
): SessionRuntimeProcessMetadata | undefined {
  if (!isObject(candidate)) {
    return undefined;
  }

  const pid = normalizePositiveIntegerField(candidate['pid']);
  if (pid === undefined) {
    return undefined;
  }

  const ppid = normalizePositiveIntegerField(candidate['ppid']);
  const processStartedAt = normalizeTrimmedStringField(candidate['processStartedAt']);
  const ancestors = Array.isArray(candidate['ancestors'])
    ? candidate['ancestors']
        .map((entry) => normalizeSessionRuntimeProcessAncestorMetadata(entry))
        .filter((entry): entry is SessionRuntimeProcessAncestorMetadata => entry !== undefined)
        .slice(0, 8)
    : [];

  return {
    pid,
    ...(ppid === undefined ? {} : { ppid }),
    ...(processStartedAt === undefined ? {} : { processStartedAt }),
    ancestors,
  };
}

function normalizeSessionRuntimeProcessAncestorMetadata(
  candidate: unknown,
): SessionRuntimeProcessAncestorMetadata | undefined {
  if (!isObject(candidate)) {
    return undefined;
  }

  const pid = normalizePositiveIntegerField(candidate['pid']);
  if (pid === undefined) {
    return undefined;
  }

  const ppid = normalizePositiveIntegerField(candidate['ppid']);
  const processStartedAt = normalizeTrimmedStringField(candidate['processStartedAt']);

  return {
    pid,
    ...(ppid === undefined ? {} : { ppid }),
    ...(processStartedAt === undefined ? {} : { processStartedAt }),
  };
}

function normalizeSessionRuntimeLaunchMetadata(
  candidate: unknown,
): SessionRuntimeLaunchMetadata | undefined {
  if (!isObject(candidate)) {
    return undefined;
  }

  const noSession = normalizeBooleanField(candidate['noSession']);
  const print = normalizeBooleanField(candidate['print']);
  const sessionArgPresent = normalizeBooleanField(candidate['sessionArgPresent']);
  const forkArgPresent = normalizeBooleanField(candidate['forkArgPresent']);
  if (
    noSession === undefined ||
    print === undefined ||
    sessionArgPresent === undefined ||
    forkArgPresent === undefined
  ) {
    return undefined;
  }

  const mode = normalizeSessionRuntimeLaunchMode(candidate['mode']);

  return {
    noSession,
    print,
    ...(mode === undefined ? {} : { mode }),
    sessionArgPresent,
    forkArgPresent,
  };
}

function normalizeSessionRuntimeLaunchMode(
  value: unknown,
): SessionRuntimeLaunchMode | undefined {
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

function normalizeSessionRuntimeStdioMetadata(
  candidate: unknown,
): SessionRuntimeStdioMetadata | undefined {
  if (!isObject(candidate)) {
    return undefined;
  }

  const stdinTTY = normalizeBooleanField(candidate['stdinTTY']);
  const stdoutTTY = normalizeBooleanField(candidate['stdoutTTY']);
  const stderrTTY = normalizeBooleanField(candidate['stderrTTY']);
  if (stdinTTY === undefined || stdoutTTY === undefined || stderrTTY === undefined) {
    return undefined;
  }

  return { stdinTTY, stdoutTTY, stderrTTY };
}

function normalizeSessionRuntimeInheritedDeckRuntimeMetadata(
  candidate: unknown,
): SessionRuntimeInheritedDeckRuntimeMetadata | undefined {
  if (!isObject(candidate)) {
    return undefined;
  }

  const runtimeId = normalizeTrimmedStringField(candidate['runtimeId']);
  const sessionId = normalizeTrimmedStringField(candidate['sessionId']);
  const sessionFile = normalizeTrimmedStringField(candidate['sessionFile']);
  const startedAt = normalizeTrimmedStringField(candidate['startedAt']);

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

function normalizeOptionalStringField(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  return undefined;
}

function normalizeTrimmedStringField(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBooleanField(value: unknown): boolean | undefined {
  if (value === true) {
    return true;
  }

  if (value === false) {
    return false;
  }

  return undefined;
}

function normalizeNonNegativeIntegerField(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function normalizePositiveIntegerField(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    return undefined;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function normalizeTmuxSocketName(value: unknown): string | undefined {
  const socketName = normalizeTrimmedStringField(value);
  if (socketName === undefined || socketName.includes('/')) {
    return undefined;
  }

  return socketName;
}

function isObject(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null;
}
