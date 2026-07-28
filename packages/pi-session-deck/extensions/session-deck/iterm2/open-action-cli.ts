#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  openTerminalForRuntime,
  type OpenTerminalForRuntimeOptions,
  type SessionDeckOpenSelectedResult,
} from '../identity/open.js';
import { openWithIterm2Runtime, type Iterm2RuntimeOpenRequest } from '../iterm2-runtime-client.js';

export const OPEN_TERMINAL_ACTION_BRIDGE_SOCKET_ENV = 'PI_SESSION_DECK_ITERM2_BRIDGE_SOCKET_PATH';

const MAX_RUNTIME_ID_LENGTH = 256;
const REQUEST_VALIDATION_MESSAGE = 'Open-terminal request must contain only runtimeId.';
const INVALID_JSON_MESSAGE = 'Open-terminal request body must be valid JSON.';
const HELPER_FAILED_MESSAGE =
  'Open-terminal helper action failed. Run /session-deck iterm2 doctor for details.';

const FORBIDDEN_OPEN_ACTION_FIELDS = new Set([
  'attachCommand',
  'command',
  'ghosttyTerminalId',
  'host',
  'itermSessionId',
  'paneId',
  'revealUrl',
  'sessionTarget',
  'shell',
  'socketName',
  'socketPath',
  'terminalDisplay',
  'terminalId',
  'tmuxArgv',
  'tmuxAttachArgv',
  'tmuxCommand',
]);

export type OpenTerminalActionFailureReason = Extract<
  SessionDeckOpenSelectedResult,
  { ok: false }
>['reason'];

export type BrowserSafeOpenTerminalActionResult =
  | {
      ok: true;
      status: 'requested';
      message: string;
    }
  | {
      ok: false;
      status: 'failed';
      reason?: OpenTerminalActionFailureReason;
      message: string;
      requestSent?: boolean;
    };

export type OpenTerminalActionOpener = (
  runtimeId: string,
) => Promise<SessionDeckOpenSelectedResult>;

export interface OpenTerminalActionRequest {
  runtimeId: string;
}

async function main(): Promise<void> {
  const input = await readStdin();
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    writeJson({ ok: false, status: 'failed', message: INVALID_JSON_MESSAGE });
    process.exitCode = 1;
    return;
  }

  const result = await runOpenTerminalAction(parsed);
  writeJson(result);
  if (!result.ok && result.reason === undefined) {
    process.exitCode = 1;
  }
}

export function normalizeOpenTerminalActionRequest(
  parsed: unknown,
): { ok: true; request: OpenTerminalActionRequest } | { ok: false; message: string } {
  if (!isRecord(parsed)) {
    return { ok: false, message: 'Open-terminal request body must be a JSON object.' };
  }

  if (findForbiddenOpenActionField(parsed) !== null) {
    return { ok: false, message: REQUEST_VALIDATION_MESSAGE };
  }

  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== 'runtimeId') {
    return { ok: false, message: REQUEST_VALIDATION_MESSAGE };
  }

  const runtimeId = parsed['runtimeId'];
  if (typeof runtimeId !== 'string') {
    return { ok: false, message: 'runtimeId must be a string.' };
  }

  const validationMessage = validateRuntimeId(runtimeId);
  if (validationMessage !== null) {
    return { ok: false, message: validationMessage };
  }

  return { ok: true, request: { runtimeId } };
}

export async function runOpenTerminalAction(
  parsed: unknown,
  opener: OpenTerminalActionOpener = createOpenTerminalActionOpener(),
): Promise<BrowserSafeOpenTerminalActionResult> {
  const request = normalizeOpenTerminalActionRequest(parsed);
  if (!request.ok) {
    return { ok: false, status: 'failed', message: request.message };
  }

  try {
    const result = await opener(request.request.runtimeId);
    return toBrowserSafeOpenTerminalActionResult(result);
  } catch {
    return {
      ok: false,
      status: 'failed',
      reason: 'open-failed',
      message: getBrowserSafeFailureMessage('open-failed'),
    };
  }
}

export function createOpenTerminalActionOpener(
  env: NodeJS.ProcessEnv = process.env,
  options: OpenTerminalForRuntimeOptions = {},
): OpenTerminalActionOpener {
  const socketPath = normalizeBridgeSocketPath(env[OPEN_TERMINAL_ACTION_BRIDGE_SOCKET_ENV]);
  if (socketPath === undefined) {
    return (runtimeId) => openTerminalForRuntime(runtimeId, options);
  }

  return (runtimeId) =>
    openTerminalForRuntime(runtimeId, {
      ...options,
      pythonBridgeClient: (request: Iterm2RuntimeOpenRequest) =>
        openWithIterm2Runtime(request, { socketPath }),
    });
}

export function toBrowserSafeOpenTerminalActionResult(
  result: SessionDeckOpenSelectedResult,
): BrowserSafeOpenTerminalActionResult {
  if (result.ok) {
    return {
      ok: true,
      status: 'requested',
      message: 'Terminal open requested.',
    };
  }

  const reason = normalizeOpenTerminalFailureReason(result.reason);
  const requestSent = 'requestSent' in result ? result.requestSent : undefined;
  return {
    ok: false,
    status: 'failed',
    reason,
    message: getBrowserSafeFailureMessage(reason),
    ...(requestSent === undefined ? {} : { requestSent }),
  };
}

function validateRuntimeId(runtimeId: string): string | null {
  if (runtimeId.length === 0) {
    return 'runtimeId must be a non-empty string.';
  }

  if (runtimeId.trim() !== runtimeId || /\s/.test(runtimeId)) {
    return 'runtimeId must be a safe identity segment.';
  }

  if (runtimeId.length > MAX_RUNTIME_ID_LENGTH) {
    return 'runtimeId is too long.';
  }

  if (runtimeId === '.' || runtimeId === '..') {
    return 'runtimeId must be a safe identity segment.';
  }

  if (runtimeId.includes('/') || runtimeId.includes('\\') || hasControlCharacter(runtimeId)) {
    return 'runtimeId must be a safe identity segment.';
  }

  return null;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function normalizeBridgeSocketPath(candidate: unknown): string | undefined {
  if (typeof candidate !== 'string') {
    return undefined;
  }

  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function findForbiddenOpenActionField(value: unknown, prefix = ''): string | null {
  if (!isRecord(value)) {
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;
    if (FORBIDDEN_OPEN_ACTION_FIELDS.has(key)) {
      return path;
    }
    const nested = findForbiddenOpenActionField(child, path);
    if (nested !== null) {
      return nested;
    }
  }

  return null;
}

function normalizeOpenTerminalFailureReason(
  reason: OpenTerminalActionFailureReason,
): OpenTerminalActionFailureReason {
  switch (reason) {
    case 'identity-missing':
    case 'identity-read-error':
    case 'identity-malformed':
    case 'runtime-mismatch':
    case 'terminal-missing':
    case 'terminal-target-incomplete':
    case 'unsupported-platform':
    case 'tmux-target-missing':
    case 'tmux-preflight-failed':
    case 'python-bridge-disabled':
    case 'python-bridge-unavailable':
    case 'automation-denied':
    case 'terminal-api-unavailable':
    case 'terminal-target-missing':
    case 'open-failed':
      return reason;
  }
}

function getBrowserSafeFailureMessage(reason: OpenTerminalActionFailureReason): string {
  switch (reason) {
    case 'identity-missing':
      return 'Terminal metadata is no longer available for this session.';
    case 'identity-read-error':
      return 'Could not read terminal metadata for this session.';
    case 'identity-malformed':
      return 'Terminal metadata for this session is invalid.';
    case 'runtime-mismatch':
      return 'Terminal metadata does not match this session.';
    case 'terminal-missing':
      return 'No openable terminal target is available for this session.';
    case 'terminal-target-incomplete':
      return 'Terminal metadata is incomplete for this session.';
    case 'unsupported-platform':
      return 'Opening terminals from Session Deck is only supported on macOS.';
    case 'tmux-target-missing':
      return 'The tmux session is no longer available.';
    case 'tmux-preflight-failed':
      return 'Could not verify the tmux session before opening.';
    case 'python-bridge-disabled':
      return 'Terminal opening through the iTerm2 runtime is disabled.';
    case 'python-bridge-unavailable':
      return 'The iTerm2 runtime is unavailable.';
    case 'automation-denied':
      return 'Terminal automation is not authorized.';
    case 'terminal-api-unavailable':
      return 'Terminal app scripting is unavailable.';
    case 'terminal-target-missing':
      return 'The terminal target is no longer available.';
    case 'open-failed':
      return 'Could not request terminal open.';
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function writeJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

function isMainModule(): boolean {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}

if (isMainModule()) {
  void main().catch(() => {
    writeJson({ ok: false, status: 'failed', message: HELPER_FAILED_MESSAGE });
    process.exitCode = 1;
  });
}
