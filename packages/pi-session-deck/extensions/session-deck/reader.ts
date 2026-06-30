import { basename } from 'node:path';
import { readSessionDeckView } from './activity/reader.js';
import type { ActivityThresholds } from './activity/types.js';
import { readSessionDeckChips } from './chips/reader.js';
import { readJoinedSessionView } from './identity/reader.js';
import type { IdentityFreshnessThresholds } from './identity/types.js';
import { readPresenceView, type ReadPresenceViewOptions } from './presence/reader.js';
import type { SessionDeckDiagnostic, SessionDeckRecord, SessionDeckSnapshot } from './types.js';

export interface ReadSessionDeckSnapshotOptions extends ReadPresenceViewOptions {
  identityDirectory?: string;
  activityDirectory?: string;
  chipsDirectory?: string;
  identityFreshnessThresholds?: Partial<IdentityFreshnessThresholds>;
  activityThresholds?: Partial<ActivityThresholds>;
}

export async function readSessionDeckSnapshot(
  options: ReadSessionDeckSnapshotOptions = {},
): Promise<SessionDeckSnapshot> {
  const now = options.now ?? new Date();
  const presenceView = await readPresenceView({
    ...(options.directory === undefined ? {} : { directory: options.directory }),
    now,
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
    ...(options.inspectPid === undefined ? {} : { inspectPid: options.inspectPid }),
    ...(options.readdir === undefined ? {} : { readdir: options.readdir }),
    ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
  });

  const joinedView = await readJoinedSessionView({
    presenceView,
    now,
    ...(options.identityDirectory === undefined
      ? {}
      : { identityDirectory: options.identityDirectory }),
    ...(options.identityFreshnessThresholds === undefined
      ? {}
      : { identityFreshnessThresholds: options.identityFreshnessThresholds }),
    ...(options.readdir === undefined ? {} : { readdir: options.readdir }),
    ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
  });

  const activityView = await readSessionDeckView({
    joinedView,
    now,
    ...(options.activityDirectory === undefined
      ? {}
      : { activityDirectory: options.activityDirectory }),
    ...(options.activityThresholds === undefined ? {} : { thresholds: options.activityThresholds }),
    ...(options.readdir === undefined ? {} : { readdir: options.readdir }),
    ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
  });

  const chipsView = await readSessionDeckChips({
    records: activityView.records.map((record) => ({
      runtimeId: record.runtimeId,
      sessionId: record.sessionId,
      sessionIdTrusted: isSessionIdTrustedForChips(record),
    })),
    ...(options.chipsDirectory === undefined ? {} : { chipsDirectory: options.chipsDirectory }),
    now,
    ...(options.readdir === undefined ? {} : { readdir: options.readdir }),
    ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
  });

  const chipsByRuntimeId = new Map(chipsView.records.map((record) => [record.runtimeId, record]));

  return {
    generatedAt: now.toISOString(),
    records: activityView.records.map((record) => {
      const chipRecord = chipsByRuntimeId.get(record.runtimeId);
      return {
        runtimeId: record.runtimeId,
        pid: record.pid,
        presenceState: record.presenceState as SessionDeckRecord['presenceState'],
        ...(record.presenceReason === undefined ? {} : { presenceReason: record.presenceReason }),
        heartbeatAgeMs: record.heartbeatAgeMs,
        sessionId: record.sessionId,
        sessionName: record.sessionName,
        repoName: getRepoName(record.worktree),
        cwd: record.cwd,
        branch: record.branch,
        prUrl: record.prUrl,
        isLinkedWorktree: record.isLinkedWorktree,
        worktreeLabel: record.worktreeLabel,
        activityState: record.activityState,
        activityAgeMs: record.activityAgeMs,
        currentToolName: record.currentToolName,
        lastError: record.lastError,
        chips: chipRecord?.chips ?? [],
        diagnostics: [
          ...record.diagnostics.map(toSessionDeckDiagnostic),
          ...(chipRecord?.diagnostics.map(toSessionDeckDiagnostic) ?? []),
        ],
      };
    }),
    diagnostics: [
      ...activityView.diagnostics.map(toSessionDeckDiagnostic),
      ...chipsView.diagnostics.map(toSessionDeckDiagnostic),
    ],
  };
}

function isSessionIdTrustedForChips(record: {
  sessionId: string | null;
  identityFreshness: string;
  diagnostics: Array<{ code: string }>;
}): boolean {
  if (record.sessionId === null || record.identityFreshness === 'missing') {
    return false;
  }

  return !record.diagnostics.some((diagnostic) => diagnostic.code === 'session_mismatch');
}

function getRepoName(worktree: string | null): string | null {
  if (worktree === null) {
    return null;
  }

  const repoName = basename(worktree);
  if (repoName.length === 0 || repoName === '/' || repoName === '.') {
    return null;
  }

  return repoName;
}

function toSessionDeckDiagnostic(diagnostic: {
  code: string;
  message: string;
  runtimeId?: string;
  filePath?: string;
}): SessionDeckDiagnostic {
  return {
    code: diagnostic.code as SessionDeckDiagnostic['code'],
    message: diagnostic.message,
    ...(diagnostic.runtimeId === undefined ? {} : { runtimeId: diagnostic.runtimeId }),
    ...(diagnostic.filePath === undefined ? {} : { filePath: diagnostic.filePath }),
  };
}
