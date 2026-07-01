import type { ActivityDiagnosticCode, ActivityState } from './activity/types.js';
import type { ChipDiagnosticCode } from './chips/types.js';
import type { IdentityDiagnosticCode } from './identity/types.js';
import type { PresenceDiagnosticCode, PresenceState } from './presence/types.js';

export type SessionDeckDiagnosticCode =
  | PresenceDiagnosticCode
  | IdentityDiagnosticCode
  | ActivityDiagnosticCode
  | ChipDiagnosticCode;

export interface SessionDeckDiagnostic {
  code: SessionDeckDiagnosticCode;
  message: string;
  runtimeId?: string;
  filePath?: string;
}

export interface SessionDeckRecord {
  runtimeId: string;
  pid: number | null;
  presenceState: PresenceState;
  presenceReason?: string;
  heartbeatAgeMs: number;
  sessionId: string | null;
  sessionName: string | null;
  repoName: string | null;
  qualifiedRepoName: string | null;
  cwd: string | null;
  branch: string | null;
  prUrl: string | null;
  isLinkedWorktree: boolean | null;
  worktreeLabel: string | null;
  activityState: ActivityState;
  activityAgeMs: number | null;
  currentToolName: string | null;
  lastError: string | null;
  chips: string[];
  diagnostics: SessionDeckDiagnostic[];
}

export interface SessionDeckSnapshot {
  generatedAt: string;
  records: SessionDeckRecord[];
  diagnostics: SessionDeckDiagnostic[];
}
