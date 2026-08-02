#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assignProject,
  createAndAssignProject,
  deleteProject,
  unassignProject,
} from '../projects/actions.js';
import type { ProjectActionOptions } from '../projects/actions.js';
import type { ProjectActionResult } from '../projects/types.js';
import { orchestrateCreateSession } from '../session/create.js';
import { restartSessionDeckRuntime } from '../restart/orchestrator.js';
import { normalizeRestartSessionRequest } from '../restart/store.js';
import type { RestartSessionRequest, RestartSessionResult } from '../restart/types.js';
import type {
  BrowserSafeCreateSessionActionResult,
  BrowserSafeCreateSessionLaunchFailure,
  CreateSessionActionRequest,
  CreateSessionActionResult,
  CreateSessionFailureReason,
  CreateSessionLaunchFailure,
} from '../session/types.js';
import { normalizeLaunchAgentDirSelection } from './agent-dir.js';
import { orchestrateCreateWorktree } from './orchestrate.js';
import { resolveWorktreeBasePreview, resolveWorktreeLaunchContextPreview } from './preview.js';
import type {
  BrowserSafeCreateWorktreeActionResult,
  BrowserSafeCreateWorktreeLaunchResult,
  BrowserSafeCreateWorktreePhaseResult,
  BrowserSafeWorktreeBasePreviewResult,
  BrowserSafeWorktreeLaunchContextPreviewResult,
  CreateWorktreeActionRequest,
  CreateWorktreeActionResult,
  CreateWorktreeFailureReason,
  CreateWorktreeLaunchFailureReason,
  CreateWorktreeLaunchSuccess,
  CreateWorktreeSuccess,
  WorktreeBasePreviewRequest,
  WorktreeBasePreviewResult,
  WorktreeLaunchContextPreviewRequest,
  WorktreeLaunchContextPreviewResult,
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

  const action = getRequestedAction(parsed);
  if (!action.ok) {
    writeJson({ ok: false, status: 'failed', message: action.message });
    process.exitCode = 1;
    return;
  }

  if (action.action === 'preview-base-ref') {
    const request = normalizeBasePreviewRequest(parsed);
    if (!request.ok) {
      writeJson({ ok: false, status: 'failed', message: request.message });
      process.exitCode = 1;
      return;
    }

    const result = await resolveWorktreeBasePreview(request.request);
    writeJson(toBrowserSafeWorktreeBasePreviewResult(result));
    return;
  }

  if (action.action === 'preview-launch-context') {
    const request = normalizeLaunchContextPreviewRequest(parsed);
    if (!request.ok) {
      writeJson({ ok: false, status: 'failed', message: request.message });
      process.exitCode = 1;
      return;
    }

    const result = await resolveWorktreeLaunchContextPreview(request.request);
    writeJson(toBrowserSafeWorktreeLaunchContextPreviewResult(result));
    return;
  }

  if (action.action === 'create-session') {
    writeJson(await runCreateSessionAction(parsed));
    return;
  }

  if (action.action === 'restart-session') {
    const request = normalizeRestartActionRequest(parsed);
    if (request === null) {
      writeJson({ ok: false, status: 'failed', message: 'Restart-session request is invalid.' });
      process.exitCode = 1;
      return;
    }
    writeJson(await runRestartSessionAction(request));
    return;
  }

  if (isProjectAction(action.action)) {
    const request = normalizeProjectActionRequest(parsed);
    if (request === null) {
      writeJson({ ok: false, status: 'failed', message: 'Project request is invalid.' });
      process.exitCode = 1;
      return;
    }
    writeJson(await runProjectAction(request));
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
  const repoIntent = normalizeRepoIntent(parsed);
  if (!repoIntent.ok) {
    return repoIntent;
  }

  if (!isRecord(parsed) || typeof parsed['branchName'] !== 'string') {
    return { ok: false, message: 'Expected repoIntent and branchName.' };
  }

  const launch = parsed['launch'];
  if (launch !== undefined) {
    if (!isRecord(launch) || launch['mode'] !== 'tmux-detached') {
      return { ok: false, message: 'launch.mode must be tmux-detached when provided.' };
    }
  }

  const agentDir = normalizeLaunchAgentDirSelection(
    isRecord(launch) ? launch['agentDir'] : undefined,
  );
  if (!agentDir.ok) {
    return { ok: false, message: agentDir.message };
  }

  return {
    ok: true,
    request: {
      repoIntent: repoIntent.repoIntent,
      branchName: parsed['branchName'],
      ...optionalStringField(parsed, 'baseRef'),
      launch: { mode: 'tmux-detached', agentDir: agentDir.agentDir },
    },
  };
}

export function normalizeBasePreviewRequest(
  parsed: unknown,
): { ok: true; request: WorktreeBasePreviewRequest } | { ok: false; message: string } {
  const repoIntent = normalizeRepoIntent(parsed);
  if (!repoIntent.ok) {
    return repoIntent;
  }

  return {
    ok: true,
    request: {
      repoIntent: repoIntent.repoIntent,
    },
  };
}

export function normalizeLaunchContextPreviewRequest(
  parsed: unknown,
): { ok: true; request: WorktreeLaunchContextPreviewRequest } | { ok: false; message: string } {
  if (!isRecord(parsed)) {
    return { ok: false, message: 'Request body must be a JSON object.' };
  }

  const forbidden = findForbiddenField(parsed);
  if (forbidden !== null) {
    return { ok: false, message: `Field is not accepted by this action boundary: ${forbidden}` };
  }

  const launch = parsed['launch'];
  if (launch !== undefined && !isRecord(launch)) {
    return { ok: false, message: 'launch must be an object when provided.' };
  }
  if (isRecord(launch) && launch['mode'] !== undefined && launch['mode'] !== 'tmux-detached') {
    return { ok: false, message: 'launch.mode must be tmux-detached when provided.' };
  }

  const agentDir = normalizeLaunchAgentDirSelection(
    isRecord(launch) ? launch['agentDir'] : parsed['agentDir'],
  );
  if (!agentDir.ok) {
    return { ok: false, message: agentDir.message };
  }

  return { ok: true, request: { agentDir: agentDir.agentDir } };
}

export function getRequestedAction(parsed: unknown):
  | {
      ok: true;
      action:
        | 'create-worktree'
        | 'create-session'
        | 'restart-session'
        | 'preview-base-ref'
        | 'preview-launch-context'
        | 'create-and-assign'
        | 'assign-project'
        | 'unassign-project'
        | 'delete-project';
    }
  | { ok: false; message: string } {
  if (!isRecord(parsed)) {
    return { ok: false, message: 'Request body must be a JSON object.' };
  }

  const action = parsed['action'];
  if (action === undefined) {
    return { ok: true, action: 'create-worktree' };
  }
  if (
    action === 'create-worktree' ||
    action === 'create-session' ||
    action === 'restart-session' ||
    action === 'preview-base-ref' ||
    action === 'preview-launch-context' ||
    action === 'create-and-assign' ||
    action === 'assign-project' ||
    action === 'unassign-project' ||
    action === 'delete-project'
  ) {
    return { ok: true, action };
  }
  return { ok: false, message: 'Unsupported worktree helper action.' };
}

function normalizeRepoIntent(parsed: unknown):
  | {
      ok: true;
      repoIntent: WorktreeBasePreviewRequest['repoIntent'];
    }
  | { ok: false; message: string } {
  if (!isRecord(parsed)) {
    return { ok: false, message: 'Request body must be a JSON object.' };
  }

  const forbidden = findForbiddenField(parsed);
  if (forbidden !== null) {
    return { ok: false, message: `Field is not accepted by this action boundary: ${forbidden}` };
  }

  const repoIntent = parsed['repoIntent'];
  if (!isRecord(repoIntent)) {
    return { ok: false, message: 'Expected repoIntent.' };
  }

  const candidateRuntimeIds = repoIntent['candidateRuntimeIds'];
  if (
    !Array.isArray(candidateRuntimeIds) ||
    !candidateRuntimeIds.every((value) => typeof value === 'string')
  ) {
    return { ok: false, message: 'repoIntent.candidateRuntimeIds must be an array of strings.' };
  }

  return {
    ok: true,
    repoIntent: {
      candidateRuntimeIds,
      ...optionalStringField(repoIntent, 'repoName'),
      ...optionalStringField(repoIntent, 'qualifiedRepoName'),
      ...optionalStringField(repoIntent, 'preferredRuntimeId'),
    },
  };
}

export function toBrowserSafeCreateWorktreeActionResult(
  result: CreateWorktreeActionResult,
): BrowserSafeCreateWorktreeActionResult {
  if (result.status === 'preflight-failed') {
    return {
      ...result,
      preflight: {
        ...result.preflight,
        message: toBrowserSafePreflightFailureMessage(result.preflight.reason),
      },
    };
  }

  if (result.status === 'failed') {
    return {
      ...result,
      worktree: {
        ...result.worktree,
        message: toBrowserSafeWorktreeFailureMessage(result.worktree.reason),
      },
    };
  }

  const worktree = toBrowserSafeWorktreeSuccess(result.worktree);

  if (result.status === 'partial-launch-failed') {
    return {
      ...result,
      worktree,
      launch: {
        requested: result.launch.requested,
        ok: result.launch.ok,
        mode: result.launch.mode,
        status: result.launch.status,
        reason: result.launch.reason,
        recoverable: result.launch.recoverable,
        message: toBrowserSafeLaunchFailureMessage(result.launch.reason),
      },
    };
  }

  if (result.status === 'worktree-created' || result.status === 'worktree-reused') {
    return { ...result, worktree, launch: result.launch };
  }

  if (result.status === 'created-and-launched' || result.status === 'reused-and-launched') {
    return {
      ...result,
      worktree,
      launch: toBrowserSafeLaunchSuccess(result.launch),
    };
  }

  throw new Error('Unhandled worktree action result status.');
}

export type ProjectActionRequest =
  | { action: 'create-and-assign'; sessionId: string; name: string }
  | { action: 'assign-project'; sessionId: string; projectId: string }
  | { action: 'unassign-project'; sessionId: string }
  | { action: 'delete-project'; projectId: string };

export function normalizeProjectActionRequest(parsed: unknown): ProjectActionRequest | null {
  if (!isRecord(parsed) || !isProjectAction(parsed['action'])) return null;

  switch (parsed['action']) {
    case 'create-and-assign':
      return hasExactKeys(parsed, ['action', 'sessionId', 'name']) &&
        typeof parsed['sessionId'] === 'string' &&
        typeof parsed['name'] === 'string'
        ? { action: parsed['action'], sessionId: parsed['sessionId'], name: parsed['name'] }
        : null;
    case 'assign-project':
      return hasExactKeys(parsed, ['action', 'sessionId', 'projectId']) &&
        typeof parsed['sessionId'] === 'string' &&
        typeof parsed['projectId'] === 'string'
        ? {
            action: parsed['action'],
            sessionId: parsed['sessionId'],
            projectId: parsed['projectId'],
          }
        : null;
    case 'unassign-project':
      return hasExactKeys(parsed, ['action', 'sessionId']) &&
        typeof parsed['sessionId'] === 'string'
        ? { action: parsed['action'], sessionId: parsed['sessionId'] }
        : null;
    case 'delete-project':
      return hasExactKeys(parsed, ['action', 'projectId']) &&
        typeof parsed['projectId'] === 'string'
        ? { action: parsed['action'], projectId: parsed['projectId'] }
        : null;
  }
}

export async function runProjectAction(
  request: ProjectActionRequest,
  options: ProjectActionOptions = {},
): Promise<ProjectActionResult> {
  let result: ProjectActionResult;
  switch (request.action) {
    case 'create-and-assign':
      result = await createAndAssignProject(request.sessionId, request.name, options);
      break;
    case 'assign-project':
      result = await assignProject(request.sessionId, request.projectId, options);
      break;
    case 'unassign-project':
      result = await unassignProject(request.sessionId, options);
      break;
    case 'delete-project':
      result = await deleteProject(request.projectId, options);
      break;
  }
  return toBrowserSafeProjectActionResult(result);
}

export function toBrowserSafeProjectActionResult(result: ProjectActionResult): ProjectActionResult {
  if (result.ok) return result;
  if (result.status === 'partial') {
    return {
      ...result,
      message: 'Project was created, but assignment could not be confirmed.',
    };
  }
  return { ...result, message: toBrowserSafeProjectFailureMessage(result.reason) };
}

function toBrowserSafeProjectFailureMessage(
  reason: Extract<ProjectActionResult, { status: 'failed' }>['reason'],
): string {
  switch (reason) {
    case 'invalid-session-id':
      return 'A non-empty session ID is required.';
    case 'invalid-project-id':
      return 'A valid project ID is required.';
    case 'invalid-project-name':
      return 'Project name must be 1–80 characters and contain no control characters.';
    case 'project-not-found':
      return 'Project does not exist.';
    case 'projects-unavailable':
      return 'Project editing is unavailable.';
    case 'write-failed':
      return 'Project update failed.';
  }
}

function isProjectAction(action: unknown): action is ProjectActionRequest['action'] {
  return (
    action === 'create-and-assign' ||
    action === 'assign-project' ||
    action === 'unassign-project' ||
    action === 'delete-project'
  );
}

export function normalizeRestartActionRequest(parsed: unknown): RestartSessionRequest | null {
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).some(
      (key) => !['action', 'runtimeId', 'generation', 'operationId'].includes(key),
    )
  )
    return null;
  return normalizeRestartSessionRequest({
    runtimeId: parsed['runtimeId'],
    generation: parsed['generation'],
    operationId: parsed['operationId'],
  });
}

export async function runRestartSessionAction(parsed: unknown): Promise<RestartSessionResult> {
  return await restartSessionDeckRuntime(parsed);
}

export async function runCreateSessionAction(
  parsed: unknown,
): Promise<BrowserSafeCreateSessionActionResult> {
  const result = await orchestrateCreateSession(parsed as CreateSessionActionRequest);
  return toBrowserSafeCreateSessionActionResult(result);
}

export function toBrowserSafeCreateSessionActionResult(
  result: CreateSessionActionResult,
): BrowserSafeCreateSessionActionResult {
  if (result.status === 'failed') {
    return {
      ...result,
      message: toBrowserSafeCreateSessionValidationFailureMessage(result.reason),
    };
  }

  if (result.status === 'preflight-failed') {
    return {
      ...result,
      preflight: {
        ...result.preflight,
        message: toBrowserSafeCreateSessionPreflightFailureMessage(result.preflight.reason),
      },
    };
  }

  if (result.status === 'launch-failed') {
    return {
      ...result,
      launch: toBrowserSafeCreateSessionLaunchFailure(result.launch),
    };
  }

  return {
    ...result,
    launch: toBrowserSafeLaunchSuccess(result.launch),
  };
}

export function toBrowserSafeWorktreeBasePreviewResult(
  result: WorktreeBasePreviewResult,
): BrowserSafeWorktreeBasePreviewResult {
  if (result.ok) {
    return result;
  }

  return {
    ...result,
    message: toBrowserSafeRepoIntentFailureMessage(result.reason),
  };
}

export function toBrowserSafeWorktreeLaunchContextPreviewResult(
  result: WorktreeLaunchContextPreviewResult,
): BrowserSafeWorktreeLaunchContextPreviewResult {
  return result;
}

function toBrowserSafeRepoIntentFailureMessage(
  reason: 'repo-intent-unresolved' | 'repo-intent-ambiguous',
): string {
  switch (reason) {
    case 'repo-intent-unresolved':
      return 'Could not resolve the selected repository.';
    case 'repo-intent-ambiguous':
      return 'The selected repository is ambiguous.';
  }
}

function toBrowserSafePreflightFailureMessage(
  reason: Extract<CreateWorktreeLaunchFailureReason, 'tmux-unavailable' | 'pi-command-unavailable'>,
): string {
  switch (reason) {
    case 'tmux-unavailable':
      return 'New Pi session requires tmux on PATH; no worktree was created.';
    case 'pi-command-unavailable':
      return 'New Pi session requires the pi executable on PATH; no worktree was created.';
  }
}

function toBrowserSafeCreateSessionValidationFailureMessage(
  reason: CreateSessionFailureReason,
): string {
  switch (reason) {
    case 'invalid-request':
      return 'Create-session request is invalid.';
    case 'invalid-cwd':
      return 'Working directory must be absolute, ~, or start with ~/.';
    case 'cwd-not-found':
      return 'Working directory does not exist.';
    case 'cwd-not-directory':
      return 'Working directory is not a directory.';
    case 'cwd-unavailable':
      return 'Working directory could not be checked.';
  }
}

function toBrowserSafeCreateSessionPreflightFailureMessage(
  reason: Extract<CreateWorktreeLaunchFailureReason, 'tmux-unavailable' | 'pi-command-unavailable'>,
): string {
  switch (reason) {
    case 'tmux-unavailable':
      return 'New Pi session requires tmux on PATH; no session was launched.';
    case 'pi-command-unavailable':
      return 'New Pi session requires the pi executable on PATH; no session was launched.';
  }
}

function toBrowserSafeCreateSessionLaunchFailure(
  launch: CreateSessionLaunchFailure,
): BrowserSafeCreateSessionLaunchFailure {
  if (launch.reason === 'cleanup-failed') {
    return {
      requested: launch.requested,
      ok: launch.ok,
      mode: launch.mode,
      status: launch.status,
      reason: launch.reason,
      recoverable: launch.recoverable,
      runtimeId: launch.runtimeId,
      message: toBrowserSafeCreateSessionLaunchFailureMessage(launch.reason),
    };
  }

  return {
    requested: launch.requested,
    ok: launch.ok,
    mode: launch.mode,
    status: launch.status,
    reason: launch.reason,
    recoverable: launch.recoverable,
    message: toBrowserSafeCreateSessionLaunchFailureMessage(launch.reason),
  };
}

function toBrowserSafeCreateSessionLaunchFailureMessage(
  reason: CreateSessionLaunchFailure['reason'],
): string {
  switch (reason) {
    case 'tmux-unavailable':
      return 'New Pi session requires tmux on PATH; no session was launched.';
    case 'pi-command-unavailable':
      return 'New Pi session requires the pi executable on PATH; no session was launched.';
    case 'tmux-name-collision':
      return 'Pi did not start because the generated tmux session name is already in use for a different cwd.';
    case 'launch-context-mismatch':
      return 'Existing managed tmux session cannot be verified against the requested Pi config.';
    case 'spawn-failed':
      return 'tmux could not start Pi.';
    case 'presence-timeout':
      return 'Pi did not remain running in tmux.';
    case 'cleanup-failed':
      return 'Pi launch cleanup could not be confirmed; check the session before retrying.';
  }
}

function toBrowserSafeWorktreeFailureMessage(reason: CreateWorktreeFailureReason): string {
  switch (reason) {
    case 'invalid-request':
      return 'Create-worktree request is invalid.';
    case 'repo-intent-unresolved':
      return toBrowserSafeRepoIntentFailureMessage(reason);
    case 'repo-intent-ambiguous':
      return toBrowserSafeRepoIntentFailureMessage(reason);
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

function toBrowserSafeLaunchFailureMessage(reason: CreateWorktreeLaunchFailureReason): string {
  switch (reason) {
    case 'tmux-unavailable':
      return 'Created worktree, but tmux is not available.';
    case 'pi-command-unavailable':
      return 'Created worktree, but the pi executable is not available.';
    case 'tmux-name-collision':
      return 'Created worktree, but an existing tmux session uses the generated name.';
    case 'launch-context-mismatch':
      return 'Created worktree, but an existing managed tmux session may use a different Pi config.';
    case 'spawn-failed':
      return 'Created worktree, but tmux could not start Pi.';
    case 'presence-timeout':
      return 'Created worktree, but Session Deck could not observe the Pi session.';
  }
}

function toBrowserSafeWorktreeSuccess(
  worktree: CreateWorktreeSuccess,
): Extract<BrowserSafeCreateWorktreePhaseResult, { ok: true }> {
  return {
    ok: worktree.ok,
    status: worktree.status,
    branch: worktree.branch,
    baseRef: worktree.baseRef,
    repoName: worktree.repoName,
    qualifiedRepoName: worktree.qualifiedRepoName,
    ...(worktree.warning === undefined ? {} : { warning: worktree.warning }),
  };
}

function toBrowserSafeLaunchSuccess(
  launch: CreateWorktreeLaunchSuccess,
): Extract<BrowserSafeCreateWorktreeLaunchResult, { requested: true; ok: true }> {
  return {
    requested: launch.requested,
    ok: launch.ok,
    mode: launch.mode,
    status: launch.status,
    ...(launch.runtimeId === undefined ? {} : { runtimeId: launch.runtimeId }),
    ...(launch.sessionId === undefined ? {} : { sessionId: launch.sessionId }),
    message: launch.message,
    ...(launch.warning === undefined ? {} : { warning: launch.warning }),
  };
}

function findForbiddenField(value: unknown, prefix = ''): string | null {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const path = prefix.length === 0 ? String(index) : `${prefix}.${index}`;
      const nested = findForbiddenField(child, path);
      if (nested !== null) {
        return nested;
      }
    }
    return null;
  }

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

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
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
      message: 'Worktree helper action failed. Run /session-deck iterm2 doctor for details.',
    });
    process.exitCode = 1;
  });
}
