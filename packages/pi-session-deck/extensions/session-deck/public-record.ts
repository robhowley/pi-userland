import type { SessionDeckDiagnostic, SessionDeckRecord } from './types.js';

export function toPublicSessionDeckRecord(record: SessionDeckRecord): SessionDeckRecord {
  return {
    runtimeId: record.runtimeId,
    pid: record.pid,
    presenceState: record.presenceState,
    ...(record.presenceReason === undefined ? {} : { presenceReason: record.presenceReason }),
    heartbeatAgeMs: record.heartbeatAgeMs,
    sessionId: record.sessionId,
    sessionName: record.sessionName,
    repoName: record.repoName,
    qualifiedRepoName: record.qualifiedRepoName,
    cwd: record.cwd,
    branch: record.branch,
    prUrl: record.prUrl,
    isLinkedWorktree: record.isLinkedWorktree,
    worktreeLabel: record.worktreeLabel,
    ...(record.derivedFacets === undefined
      ? {}
      : {
          derivedFacets: {
            persistence: record.derivedFacets.persistence,
            interactivity: record.derivedFacets.interactivity,
            lifecycle: record.derivedFacets.lifecycle,
            lineage: record.derivedFacets.lineage,
            identityStrength: record.derivedFacets.identityStrength,
            headerConsistency: record.derivedFacets.headerConsistency,
          },
        }),
    activityState: record.activityState,
    activityAgeMs: record.activityAgeMs,
    currentToolName: record.currentToolName,
    lastError: record.lastError,
    chips: [...record.chips],
    diagnostics: record.diagnostics.map(toPublicSessionDeckDiagnostic),
  };
}

export function toPublicSessionDeckDiagnostic(
  diagnostic: SessionDeckDiagnostic,
): SessionDeckDiagnostic {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    ...(diagnostic.runtimeId === undefined ? {} : { runtimeId: diagnostic.runtimeId }),
    ...(diagnostic.filePath === undefined ? {} : { filePath: diagnostic.filePath }),
  };
}
