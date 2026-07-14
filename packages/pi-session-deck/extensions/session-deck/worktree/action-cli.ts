#!/usr/bin/env node
import { orchestrateCreateWorktree } from './orchestrate.js';
import type { CreateWorktreeActionRequest } from './types.js';

const FORBIDDEN_BROWSER_FIELDS = new Set([
  'cwd',
  'gitRoot',
  'worktreeRoot',
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
  writeJson(result);
}

function normalizeActionRequest(
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
  const label = parsed['label'];
  if (!isRecord(repoIntent) || typeof label !== 'string') {
    return { ok: false, message: 'Expected repoIntent and label.' };
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
      label,
      ...optionalStringField(parsed, 'branchName'),
      ...optionalStringField(parsed, 'baseRef'),
      ...optionalStringField(parsed, 'path'),
      launch: { mode: launchMode },
    },
  };
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

void main().catch((error) => {
  writeJson({ ok: false, status: 'failed', message: getErrorMessage(error) });
  process.exitCode = 1;
});
