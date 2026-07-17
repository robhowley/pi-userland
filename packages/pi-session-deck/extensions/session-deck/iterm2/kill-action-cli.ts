#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  terminateSessionDeckRuntime,
  type TerminateSessionDeckRuntimeFailureReason,
  type TerminateSessionDeckRuntimeResult,
} from '../presence/terminate.js';
import { isSafePresenceRuntimeIdSegment } from '../presence/store.js';

const REQUEST_VALIDATION_MESSAGE = 'Kill-session request must contain only runtimeId.';
const INVALID_JSON_MESSAGE = 'Kill-session request body must be valid JSON.';
const HELPER_FAILED_MESSAGE =
  'Kill-session helper action failed. Run /session-deck iterm2 doctor for details.';

const FORBIDDEN_KILL_ACTION_FIELDS = new Set([
  'pid',
  'signal',
  'cwd',
  'sessionFile',
  'sessionPath',
  'terminal',
  'tmux',
  'tmuxArgv',
  'tmuxCommand',
  'tmuxSessionName',
  'iterm',
  'iTerm',
  'iterm2',
  'iTerm2',
  'socket',
  'socketPath',
  'socketName',
  'shell',
  'command',
  'attachCommand',
]);

export type KillSessionFailureReason = TerminateSessionDeckRuntimeFailureReason;

export type BrowserSafeKillSessionActionResult =
  | {
      ok: true;
      status: 'requested';
      message: string;
    }
  | {
      ok: true;
      status: 'already-exited';
      message: string;
    }
  | {
      ok: false;
      status: 'failed';
      reason?: KillSessionFailureReason;
      message: string;
    };

export type KillSessionActionKiller = (
  runtimeId: string,
) => Promise<TerminateSessionDeckRuntimeResult>;

export interface KillSessionActionRequest {
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

  const result = await runKillSessionAction(parsed);
  writeJson(result);
  if (!result.ok && result.reason === undefined) {
    process.exitCode = 1;
  }
}

export function normalizeKillSessionActionRequest(
  parsed: unknown,
): { ok: true; request: KillSessionActionRequest } | { ok: false; message: string } {
  if (!isRecord(parsed)) {
    return { ok: false, message: 'Kill-session request body must be a JSON object.' };
  }

  if (findForbiddenKillActionField(parsed) !== null) {
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

  if (!isSafePresenceRuntimeIdSegment(runtimeId)) {
    return { ok: false, message: 'runtimeId must be a safe presence segment.' };
  }

  return { ok: true, request: { runtimeId } };
}

export async function runKillSessionAction(
  parsed: unknown,
  killer: KillSessionActionKiller = terminateSessionDeckRuntime,
): Promise<BrowserSafeKillSessionActionResult> {
  const request = normalizeKillSessionActionRequest(parsed);
  if (!request.ok) {
    return { ok: false, status: 'failed', message: request.message };
  }

  try {
    const result = await killer(request.request.runtimeId);
    return toBrowserSafeKillSessionActionResult(result);
  } catch {
    return {
      ok: false,
      status: 'failed',
      reason: 'signal-failed',
      message: getBrowserSafeFailureMessage('signal-failed'),
    };
  }
}

export function toBrowserSafeKillSessionActionResult(
  result: TerminateSessionDeckRuntimeResult,
): BrowserSafeKillSessionActionResult {
  if (result.ok) {
    if (result.status === 'already-exited') {
      return {
        ok: true,
        status: 'already-exited',
        message: 'This Pi session is no longer running.',
      };
    }

    return {
      ok: true,
      status: 'requested',
      message: 'Stop requested for this Pi session.',
    };
  }

  const reason = normalizeKillSessionFailureReason(result.reason);
  return {
    ok: false,
    status: 'failed',
    reason,
    message: getBrowserSafeFailureMessage(reason),
  };
}

function findForbiddenKillActionField(value: unknown, prefix = ''): string | null {
  if (!isRecord(value)) {
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;
    if (FORBIDDEN_KILL_ACTION_FIELDS.has(key)) {
      return path;
    }
    const nested = findForbiddenKillActionField(child, path);
    if (nested !== null) {
      return nested;
    }
  }

  return null;
}

function normalizeKillSessionFailureReason(
  reason: KillSessionFailureReason,
): KillSessionFailureReason {
  switch (reason) {
    case 'invalid-runtime-id':
    case 'presence-missing':
    case 'presence-malformed':
    case 'runtime-mismatch':
    case 'pid-reused':
    case 'pid-unverified':
    case 'self-signal-denied':
    case 'permission-denied':
    case 'signal-failed':
      return reason;
  }
}

function getBrowserSafeFailureMessage(reason: KillSessionFailureReason): string {
  switch (reason) {
    case 'invalid-runtime-id':
      return 'Session runtime metadata is invalid.';
    case 'presence-missing':
      return 'Session runtime metadata is no longer available.';
    case 'presence-malformed':
    case 'runtime-mismatch':
      return 'Session runtime metadata is invalid.';
    case 'pid-reused':
      return 'The recorded process no longer matches this session.';
    case 'pid-unverified':
      return 'Could not safely verify the selected process.';
    case 'self-signal-denied':
      return 'Session Deck cannot signal its own helper process.';
    case 'permission-denied':
      return 'Termination is not permitted for this process.';
    case 'signal-failed':
      return 'Could not request session stop.';
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
