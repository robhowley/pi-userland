import type {
  SessionHeaderMetadata,
  SessionStartMetadata,
  SessionStartMode,
  SessionStartReason,
} from './types.js';

export function normalizeSessionStartMetadata(
  candidate: unknown,
): SessionStartMetadata | undefined {
  if (!isObject(candidate)) {
    return undefined;
  }

  const reason = normalizeSessionStartReason(candidate['reason']);
  if (reason === undefined) {
    return undefined;
  }

  const previousSessionFile = normalizeOptionalStringField(candidate['previousSessionFile']);
  const mode = normalizeSessionStartMode(candidate['mode']);
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

function normalizeSessionStartReason(value: unknown): SessionStartReason | undefined {
  switch (value) {
    case 'startup':
    case 'reload':
    case 'new':
    case 'resume':
    case 'fork':
      return value;
    default:
      return undefined;
  }
}

function normalizeSessionStartMode(value: unknown): SessionStartMode | undefined {
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

function normalizeOptionalStringField(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  return undefined;
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
