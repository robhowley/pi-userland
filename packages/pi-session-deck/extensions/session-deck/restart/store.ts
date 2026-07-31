import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { isValidAssignedPresenceRuntimeId } from '../presence/store.js';
import type { ManagedRestartRecipeV1, RestartJournalV1, RestartSessionRequest } from './types.js';

const RESTART_PATH_SEGMENTS = ['.pi', 'session-deck', 'restart'] as const;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function getDefaultRestartDirectory(homeDirectory = homedir()): string {
  return join(homeDirectory, ...RESTART_PATH_SEGMENTS);
}

export function getRestartRecipePath(
  runtimeId: string,
  directory = getDefaultRestartDirectory(),
): string {
  return join(directory, 'recipes', `${runtimeId}.json`);
}

export function getRestartJournalPath(
  runtimeId: string,
  directory = getDefaultRestartDirectory(),
): string {
  return join(directory, 'journals', `${runtimeId}.json`);
}

export function getRestartLockPath(
  runtimeId: string,
  directory = getDefaultRestartDirectory(),
): string {
  return join(directory, 'locks', runtimeId);
}

export function createRestartGeneration(
  runtimeId: string,
  pid: number,
  osProcessStartedAt: string,
): string {
  return createHash('sha256')
    .update(`${runtimeId}\0${pid}\0${osProcessStartedAt}`)
    .digest('base64url');
}

export function normalizeRestartSessionRequest(candidate: unknown): RestartSessionRequest | null {
  if (
    !isRecord(candidate) ||
    Object.keys(candidate).some((key) => !['runtimeId', 'generation', 'operationId'].includes(key))
  ) {
    return null;
  }
  const runtimeId = candidate['runtimeId'];
  const generation = candidate['generation'];
  const operationId = candidate['operationId'];
  if (
    typeof runtimeId !== 'string' ||
    !isValidAssignedPresenceRuntimeId(runtimeId) ||
    typeof generation !== 'string' ||
    generation.length < 16 ||
    generation.length > 128 ||
    typeof operationId !== 'string' ||
    !OPERATION_ID_PATTERN.test(operationId)
  ) {
    return null;
  }
  return { runtimeId, generation, operationId };
}

export async function writeRestartRecipe(
  recipe: ManagedRestartRecipeV1,
  directory = getDefaultRestartDirectory(),
): Promise<void> {
  await writePrivateJson(getRestartRecipePath(recipe.runtimeId, directory), recipe);
}

export async function readRestartRecipe(
  runtimeId: string,
  directory = getDefaultRestartDirectory(),
): Promise<ManagedRestartRecipeV1 | null> {
  return normalizeManagedRestartRecipe(
    await readOwnedJson(getRestartRecipePath(runtimeId, directory)),
    runtimeId,
  );
}

export async function removeRestartRecipe(
  runtimeId: string,
  directory = getDefaultRestartDirectory(),
): Promise<void> {
  await rm(getRestartRecipePath(runtimeId, directory), { force: true });
}

export async function removeRestartJournal(
  runtimeId: string,
  directory = getDefaultRestartDirectory(),
): Promise<void> {
  await rm(getRestartJournalPath(runtimeId, directory), { force: true });
}

export async function writeRestartJournal(
  journal: RestartJournalV1,
  directory = getDefaultRestartDirectory(),
): Promise<void> {
  await writePrivateJson(getRestartJournalPath(journal.runtimeId, directory), journal);
}

export async function readRestartJournal(
  runtimeId: string,
  directory = getDefaultRestartDirectory(),
): Promise<RestartJournalV1 | null> {
  return normalizeRestartJournal(
    await readOwnedJson(getRestartJournalPath(runtimeId, directory)),
    runtimeId,
  );
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const parent = path.slice(0, path.lastIndexOf('/'));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await stat(parent).then(async (info) => {
    if (!info.isDirectory() || !isCurrentUserOwned(info.uid) || (info.mode & 0o077) !== 0)
      throw new Error('private-state-owner-mismatch');
  });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(tempPath, path);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function readOwnedJson(path: string): Promise<unknown> {
  try {
    const info = await stat(path);
    if (!info.isFile() || !isCurrentUserOwned(info.uid) || (info.mode & 0o077) !== 0) return null;
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

export function normalizeManagedRestartRecipe(
  candidate: unknown,
  runtimeId?: string,
): ManagedRestartRecipeV1 | null {
  if (
    !isRecord(candidate) ||
    candidate['schemaVersion'] !== 1 ||
    !hasOnlyKeys(candidate, [
      'schemaVersion',
      'runtimeId',
      'launch',
      'cwd',
      'tmux',
      'createdAt',
      'binding',
    ])
  )
    return null;
  const rid = candidate['runtimeId'];
  const launch = candidate['launch'];
  const cwd = candidate['cwd'];
  const tmux = candidate['tmux'];
  const createdAt = candidate['createdAt'];
  if (
    typeof rid !== 'string' ||
    !isValidAssignedPresenceRuntimeId(rid) ||
    (runtimeId !== undefined && rid !== runtimeId) ||
    !isAbsoluteNonEmpty(cwd) ||
    !isIsoDate(createdAt) ||
    !isRecord(launch) ||
    !hasOnlyKeys(launch, ['piExecutable', 'effectivePath', 'agentDir', 'sessionDir']) ||
    !isAbsoluteNonEmpty(launch['piExecutable']) ||
    typeof launch['effectivePath'] !== 'string' ||
    launch['effectivePath'].length > 16_384 ||
    /[\r\n\0]/u.test(launch['effectivePath']) ||
    !isAgentDir(launch['agentDir']) ||
    !isSessionDir(launch['sessionDir']) ||
    !isRecord(tmux) ||
    !hasOnlyKeys(tmux, ['socketSelector', 'sessionName', 'windowIndex', 'paneIndex']) ||
    !isTmuxSocketSelector(tmux['socketSelector']) ||
    !isSafeTmuxName(tmux['sessionName']) ||
    !isNonNegativeInteger(tmux['windowIndex']) ||
    !isNonNegativeInteger(tmux['paneIndex'])
  )
    return null;

  const binding = normalizeBinding(candidate['binding']);
  if (candidate['binding'] !== undefined && binding === undefined) return null;
  return candidate as unknown as ManagedRestartRecipeV1;
}

function normalizeBinding(candidate: unknown): ManagedRestartRecipeV1['binding'] | undefined {
  if (candidate === undefined) return undefined;
  if (
    !isRecord(candidate) ||
    !hasOnlyKeys(candidate, ['sessionId', 'sessionFile', 'pid', 'osProcessStartedAt', 'boundAt'])
  )
    return undefined;
  const sessionId = candidate['sessionId'];
  const sessionFile = candidate['sessionFile'];
  const pid = candidate['pid'];
  const osProcessStartedAt = candidate['osProcessStartedAt'];
  const boundAt = candidate['boundAt'];
  if (
    typeof sessionId !== 'string' ||
    sessionId.length === 0 ||
    !isAbsoluteNonEmpty(sessionFile) ||
    !isPositiveInteger(pid) ||
    !isIsoDate(osProcessStartedAt) ||
    !isIsoDate(boundAt)
  )
    return undefined;
  return { sessionId, sessionFile, pid, osProcessStartedAt, boundAt };
}

function normalizeRestartJournal(candidate: unknown, runtimeId: string): RestartJournalV1 | null {
  if (
    !isRecord(candidate) ||
    candidate['schemaVersion'] !== 1 ||
    candidate['runtimeId'] !== runtimeId ||
    !hasOnlyKeys(candidate, [
      'schemaVersion',
      'runtimeId',
      'generation',
      'operationId',
      'state',
      'coordinator',
      'oldPid',
      'oldOsProcessStartedAt',
      'oldPresenceStartedAt',
      'previousRemainOnExit',
      'pane',
      'updatedAt',
      'messageCode',
    ])
  )
    return null;
  const generation = candidate['generation'];
  const operationId = candidate['operationId'];
  const coordinator = candidate['coordinator'];
  if (
    typeof generation !== 'string' ||
    generation.length < 16 ||
    generation.length > 128 ||
    typeof operationId !== 'string' ||
    !OPERATION_ID_PATTERN.test(operationId) ||
    !isRestartState(candidate['state']) ||
    !isRecord(coordinator) ||
    !hasOnlyKeys(coordinator, ['pid', 'osProcessStartedAt']) ||
    !isPositiveInteger(coordinator['pid']) ||
    !isIsoDate(coordinator['osProcessStartedAt']) ||
    !isPositiveInteger(candidate['oldPid']) ||
    !isIsoDate(candidate['oldOsProcessStartedAt']) ||
    !isIsoDate(candidate['oldPresenceStartedAt']) ||
    !isIsoDate(candidate['updatedAt']) ||
    !isPreviousRemainOnExit(candidate['previousRemainOnExit']) ||
    !isJournalPane(candidate['pane']) ||
    (candidate['messageCode'] !== undefined && !isRestartReasonCode(candidate['messageCode']))
  )
    return null;
  return candidate as unknown as RestartJournalV1;
}

export async function assertExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

function isCurrentUserOwned(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
function isAbsoluteNonEmpty(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && isAbsolute(value) && !/[\r\n\0]/u.test(value)
  );
}
function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function isTmuxSocketSelector(value: unknown): value is string {
  return (
    value === 'name:default' ||
    (typeof value === 'string' &&
      value.startsWith('path:/') &&
      value.length <= 1024 &&
      !/[\r\n\0]/u.test(value))
  );
}
function isSafeTmuxName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 80 &&
    /^[A-Za-z0-9_.-]+$/u.test(value)
  );
}
function isAgentDir(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ['mode', 'path'])) return false;
  if (value['mode'] === 'default') return value['path'] === undefined;
  if (value['mode'] === 'ambient')
    return value['path'] === undefined || isAbsoluteNonEmpty(value['path']);
  return value['mode'] === 'custom' && isAbsoluteNonEmpty(value['path']);
}
function isSessionDir(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      hasOnlyKeys(value, ['mode', 'path']) &&
      value['mode'] === 'explicit' &&
      isAbsoluteNonEmpty(value['path']))
  );
}
function isPreviousRemainOnExit(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      hasOnlyKeys(value, ['explicit', 'value']) &&
      typeof value['explicit'] === 'boolean' &&
      (value['explicit']
        ? value['value'] === 'on' || value['value'] === 'off'
        : value['value'] === undefined))
  );
}
function isJournalPane(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      hasOnlyKeys(value, ['id', 'socketPath', 'sessionName', 'windowIndex', 'paneIndex']) &&
      typeof value['id'] === 'string' &&
      /^%\d+$/u.test(value['id']) &&
      isAbsoluteNonEmpty(value['socketPath']) &&
      isSafeTmuxName(value['sessionName']) &&
      isNonNegativeInteger(value['windowIndex']) &&
      isNonNegativeInteger(value['paneIndex']))
  );
}
function isRestartReasonCode(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    [
      'replacement-observed',
      'managed-recipe-unavailable',
      'recipe-not-bound',
      'recipe-invalid',
      'runtime-unavailable',
      'identity-mismatch',
      'session-file-unavailable',
      'cwd-unavailable',
      'pi-executable-unavailable',
      'tmux-target-unavailable',
      'tmux-pane-mismatch',
      'unsafe-descendants',
      'hosting-runtime',
      'coordinator-runtime',
      'generation-changed',
      'operation-in-progress',
      'termination-failed',
      'pane-did-not-stop',
      'respawn-failed',
      'replacement-unobserved',
      'operation-state-unknown',
    ].includes(value)
  );
}
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function isRestartState(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    [
      'preparing',
      'term-sent',
      'kill-sent',
      'stopped',
      'spawn-requested',
      'observing',
      'restarted',
      'stop-failed',
      'stopped-not-restarted',
      'outcome-unknown',
    ].includes(value)
  );
}
