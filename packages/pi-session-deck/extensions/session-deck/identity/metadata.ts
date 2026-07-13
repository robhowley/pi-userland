import type {
  SessionHeaderMetadata,
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
