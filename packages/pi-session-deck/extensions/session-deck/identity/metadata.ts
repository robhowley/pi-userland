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
  if (!isObject(candidate) || candidate['kind'] !== 'iterm2') {
    return undefined;
  }

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

function isObject(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null;
}
