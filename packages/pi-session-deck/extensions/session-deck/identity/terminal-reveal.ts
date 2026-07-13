import { readFile } from 'node:fs/promises';
import { normalizeSessionTerminalMetadata } from './metadata.js';
import { getIdentityRecordPath } from './store.js';
import type { IdentityFileReader } from './reader.js';

export type IdentityTerminalRevealLookupFailureReason =
  | 'identity-missing'
  | 'identity-read-error'
  | 'identity-malformed'
  | 'runtime-mismatch'
  | 'terminal-missing';

export type IdentityTerminalRevealLookupResult =
  | { ok: true; revealUrl: string }
  | {
      ok: false;
      reason: IdentityTerminalRevealLookupFailureReason;
      message: string;
    };

export interface IdentityTerminalRevealLookupOptions {
  identityDirectory?: string;
  readFile?: IdentityFileReader;
}

export async function lookupIdentityTerminalRevealUrl(
  runtimeId: string,
  options: IdentityTerminalRevealLookupOptions = {},
): Promise<IdentityTerminalRevealLookupResult> {
  const filePath = getIdentityRecordPath(runtimeId, options.identityDirectory);
  const readFileImpl = (options.readFile ?? readFile) as IdentityFileReader;

  let source: string;
  try {
    source = await readFileImpl(filePath, 'utf8');
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === 'ENOENT') {
      return {
        ok: false,
        reason: 'identity-missing',
        message: 'No identity metadata is available for the selected session.',
      };
    }

    return {
      ok: false,
      reason: 'identity-read-error',
      message: `Failed to read identity metadata: ${getErrorMessage(error)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    return {
      ok: false,
      reason: 'identity-malformed',
      message: `Identity metadata is malformed: ${getErrorMessage(error)}`,
    };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      reason: 'identity-malformed',
      message: 'Identity metadata is malformed for the selected session.',
    };
  }

  const loadedRuntimeId = parsed['runtimeId'];
  if (typeof loadedRuntimeId !== 'string' || loadedRuntimeId.length === 0) {
    return {
      ok: false,
      reason: 'identity-malformed',
      message: 'Identity metadata is missing a runtime id for the selected session.',
    };
  }

  if (loadedRuntimeId !== runtimeId) {
    return {
      ok: false,
      reason: 'runtime-mismatch',
      message: 'Identity metadata did not match the selected session.',
    };
  }

  const terminal = normalizeSessionTerminalMetadata(parsed['terminal']);
  if (terminal === undefined) {
    return {
      ok: false,
      reason: 'terminal-missing',
      message: 'No iTerm2 terminal metadata is available for the selected session.',
    };
  }

  return { ok: true, revealUrl: terminal.revealUrl };
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}
