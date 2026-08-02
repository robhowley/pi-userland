import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getDefaultIdentityDirectory, getIdentityRecordPath } from '../identity/store.js';
import type { SessionDeckRecord } from '../types.js';
import { getDefaultRestartDirectory, readRestartJournal, readRestartRecipe } from './store.js';

const RECOVERY_STATES = new Set([
  'term-sent',
  'kill-sent',
  'stopped',
  'stopped-not-restarted',
  'spawn-requested',
  'observing',
  'outcome-unknown',
]);

export async function readRestartRecoveryRecords(
  existingRuntimeIds: ReadonlySet<string>,
  options: { restartDirectory?: string; identityDirectory?: string; now?: Date } = {},
): Promise<SessionDeckRecord[]> {
  const restartDirectory = options.restartDirectory ?? getDefaultRestartDirectory();
  const journalDirectory = join(restartDirectory, 'journals');
  let entries: Dirent[];
  try {
    entries = await readdir(journalDirectory, { withFileTypes: true });
  } catch {
    return [];
  }

  const records: SessionDeckRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const runtimeId = entry.name.slice(0, -'.json'.length);
    if (existingRuntimeIds.has(runtimeId)) continue;
    const journal = await readRestartJournal(runtimeId, restartDirectory);
    const recipe = await readRestartRecipe(runtimeId, restartDirectory);
    if (journal === null || recipe?.binding === undefined || !RECOVERY_STATES.has(journal.state))
      continue;
    const identity = await readIdentity(runtimeId, options.identityDirectory);
    const age = Math.max(0, (options.now ?? new Date()).getTime() - Date.parse(journal.updatedAt));
    records.push({
      runtimeId,
      pid: null,
      presenceState: 'unknown',
      presenceReason: 'restart_recovery',
      heartbeatAgeMs: Number.isFinite(age) ? age : 0,
      sessionId: stringOrNull(identity?.['sessionId']),
      projectId: null,
      sessionName: stringOrNull(identity?.['sessionName']),
      repoName: stringOrNull(identity?.['repoName']),
      qualifiedRepoName: stringOrNull(identity?.['qualifiedRepoName']),
      cwd: stringOrNull(identity?.['cwd']),
      branch: stringOrNull(identity?.['branch']),
      prUrl: stringOrNull(identity?.['prUrl']),
      isLinkedWorktree: booleanOrNull(identity?.['isLinkedWorktree']),
      worktreeLabel: stringOrNull(identity?.['worktreeLabel']),
      restart: {
        available: true,
        generation: journal.generation,
        operation: {
          operationId: journal.operationId,
          status: journal.state,
          retryable: true,
        },
      },
      activityState: 'unknown',
      activityAgeMs: null,
      currentToolName: null,
      lastError:
        journal.state === 'stopped' || journal.state === 'stopped-not-restarted'
          ? 'Pi stopped before restart completed.'
          : 'Restart outcome needs reconciliation.',
      compaction: null,
      chips: [],
      diagnostics: [],
    });
  }
  return records;
}

async function readIdentity(
  runtimeId: string,
  directory?: string,
): Promise<Record<string, unknown> | null> {
  try {
    const path = getIdentityRecordPath(runtimeId, directory ?? getDefaultIdentityDirectory());
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return isRecord(parsed) && parsed['runtimeId'] === runtimeId ? parsed : null;
  } catch {
    return null;
  }
}
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
