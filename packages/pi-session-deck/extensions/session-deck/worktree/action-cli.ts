#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { orchestrateCreateWorktree } from './orchestrate.js';
import type {
  BrowserSafeCreateWorktreeActionResult,
  CreateWorktreeActionRequest,
  CreateWorktreeActionResult,
} from './types.js';

const FORBIDDEN_BROWSER_FIELDS = new Set([
  'label',
  'cwd',
  'gitRoot',
  'worktreeRoot',
  'path',
  'manualCommand',
  'manualAttachCommand',
  'tmuxSessionName',
  'tmuxTarget',
  'paneId',
  'itermSessionId',
  'tmuxArgv',
  'tmuxCommand',
  'piArgv',
  'piCommand',
  'shell',
  'command',
  'socketPath',
  'sessionFile',
]);

async function main(): Promise<void> {
  const input = await readStdin();
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    writeJson({ ok: false, status: 'failed', message: `Invalid JSON: ${getErrorMessage(error)}` });
    process.exitCode = 1;
    return;
  }

  const request = normalizeActionRequest(parsed);
  if (!request.ok) {
    writeJson({ ok: false, status: 'failed', message: request.message });
    process.exitCode = 1;
    return;
  }

  const result = await orchestrateCreateWorktree(request.request);
  writeJson(toBrowserSafeCreateWorktreeActionResult(result));
}

export function normalizeActionRequest(
  parsed: unknown,
): { ok: true; request: CreateWorktreeActionRequest } | { ok: false; message: string } {
  if (!isRecord(parsed)) {
    return { ok: false, message: 'Request body must be a JSON object.' };
  }

  const forbidden = findForbiddenField(parsed);
  if (forbidden !== null) {
    return { ok: false, message: `Field is not accepted by this action boundary: ${forbidden}` };
  }

  const repoIntent = parsed['repoIntent'];
  const branchName = parsed['branchName'];
  if (!isRecord(repoIntent) || typeof branchName !== 'string') {
    return { ok: false, message: 'Expected repoIntent and branchName.' };
  }

  const candidateRuntimeIds = repoIntent['candidateRuntimeIds'];
  if (
    !Array.isArray(candidateRuntimeIds) ||
    !candidateRuntimeIds.every((value) => typeof value === 'string')
  ) {
    return { ok: false, message: 'repoIntent.candidateRuntimeIds must be an array of strings.' };
  }

  const launchMode = isRecord(parsed['launch']) ? parsed['launch']['mode'] : 'tmux-detached';
  if (launchMode !== 'none' && launchMode !== 'tmux-detached') {
    return { ok: false, message: 'launch.mode must be none or tmux-detached.' };
  }

  return {
    ok: true,
    request: {
      repoIntent: {
        candidateRuntimeIds,
        ...optionalStringField(repoIntent, 'repoName'),
        ...optionalStringField(repoIntent, 'qualifiedRepoName'),
        ...optionalStringField(repoIntent, 'preferredRuntimeId'),
      },
      branchName,
      ...optionalStringField(parsed, 'baseRef'),
      launch: { mode: launchMode },
    },
  };
}

export function toBrowserSafeCreateWorktreeActionResult(
  result: CreateWorktreeActionResult,
): BrowserSafeCreateWorktreeActionResult {
  if (!result.ok) {
    return {
      ...result,
      worktree: {
        ...result.worktree,
        message: toBrowserSafeWorktreeFailureMessage(result.worktree.reason),
      },
    };
  }

  const worktree = {
    ok: result.worktree.ok,
    status: result.worktree.status,
    branch: result.worktree.branch,
    baseRef: result.worktree.baseRef,
    repoName: result.worktree.repoName,
    qualifiedRepoName: result.worktree.qualifiedRepoName,
    ...(result.worktree.warning === undefined ? {} : { warning: result.worktree.warning }),
  };
  if (!result.launch.requested) {
    return { ...result, worktree, launch: result.launch } as BrowserSafeCreateWorktreeActionResult;
  }

  if (!result.launch.ok) {
    const launch = {
      requested: result.launch.requested,
      ok: result.launch.ok,
      mode: result.launch.mode,
      status: result.launch.status,
      reason: result.launch.reason,
      recoverable: result.launch.recoverable,
      message: toBrowserSafeLaunchFailureMessage(result.launch.reason),
    };
    return { ...result, worktree, launch } as BrowserSafeCreateWorktreeActionResult;
  }

  const launch = {
    requested: result.launch.requested,
    ok: result.launch.ok,
    mode: result.launch.mode,
    status: result.launch.status,
    ...(result.launch.runtimeId === undefined ? {} : { runtimeId: result.launch.runtimeId }),
    ...(result.launch.sessionId === undefined ? {} : { sessionId: result.launch.sessionId }),
    message: result.launch.message,
    ...(result.launch.warning === undefined ? {} : { warning: result.launch.warning }),
  };
  return { ...result, worktree, launch } as BrowserSafeCreateWorktreeActionResult;
}

function toBrowserSafeWorktreeFailureMessage(
  reason: Extract<CreateWorktreeActionResult, { ok: false }>['worktree']['reason'],
): string {
  switch (reason) {
    case 'invalid-request':
      return 'Create-worktree request is invalid.';
    case 'repo-intent-unresolved':
      return 'Could not resolve the selected repository.';
    case 'repo-intent-ambiguous':
      return 'The selected repository is ambiguous.';
    case 'invalid-label':
      return 'Could not derive a worktree path segment from the branch name.';
    case 'invalid-branch':
      return 'Branch name is not valid.';
    case 'invalid-base-ref':
      return 'Base ref does not resolve to a commit.';
    case 'path-collision':
      return 'A worktree path is already in use.';
    case 'branch-collision':
      return 'A worktree branch is already in use.';
    case 'git-failed':
      return 'Git could not create the worktree.';
    case 'lock-busy':
      return 'Another create-worktree operation is already in progress.';
  }
}

function toBrowserSafeLaunchFailureMessage(
  reason: Extract<
    CreateWorktreeActionResult,
    { status: 'partial-launch-failed' }
  >['launch']['reason'],
): string {
  switch (reason) {
    case 'tmux-unavailable':
      return 'Created worktree, but tmux is not available.';
    case 'pi-command-unavailable':
      return 'Created worktree, but the pi executable is not available.';
    case 'tmux-name-collision':
      return 'Created worktree, but an existing tmux session uses the generated name.';
    case 'spawn-failed':
      return 'Created worktree, but tmux could not start Pi.';
    case 'presence-timeout':
      return 'Created worktree, but Session Deck could not observe the Pi session.';
  }
}

function findForbiddenField(value: unknown, prefix = ''): string | null {
  if (!isRecord(value)) {
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;
    if (FORBIDDEN_BROWSER_FIELDS.has(key)) {
      return path;
    }
    const nested = findForbiddenField(child, path);
    if (nested !== null) {
      return nested;
    }
  }

  return null;
}

function optionalStringField<T extends string>(
  record: Record<string, unknown>,
  key: T,
): Partial<Record<T, string>> {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0
    ? ({ [key]: value } as Partial<Record<T, string>>)
    : {};
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

function isMainModule(): boolean {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}

if (isMainModule()) {
  void main().catch(() => {
    writeJson({
      ok: false,
      status: 'failed',
      message: 'Create-worktree action failed. Run /session-deck iterm2 doctor for details.',
    });
    process.exitCode = 1;
  });
}
