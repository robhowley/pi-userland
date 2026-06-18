import type { PresenceDiagnosticCode } from '../presence/types.js';

// ─── Session manager ────────────────────────────────────────────────

export interface SessionManagerLike {
  getSessionId: () => string | null;
  getSessionFile: () => string | null;
  getSessionName?: () => string | null | undefined;
}

// ─── Identity runtime controller ─────────────────────────────────────

export interface IdentityRuntimeController {
  refreshIdentity: (source: string, sessionManager?: SessionManagerLike) => Promise<void>;
  getIdentity: () => SessionIdentityRecord | null;
  isRunning: () => boolean;
}

// ─── Identity record ────────────────────────────────────────────────

export interface SessionIdentityRecord {
  runtimeId: string;
  sessionId: string | null;
  sessionFile: string | null;
  sessionName?: string;
  cwd: string | null;
  worktree: string | null;
  branch: string | null;
  prUrl: string | null;
  identityUpdatedAt: string;
  sessionStartedAt: string;
  gitRemote: string | null;
  gitRoot: string | null;
  identitySource: string;
  diagnostics?: IdentityDiagnostic[];
}

// ─── Identity diagnostics ───────────────────────────────────────────

export type IdentityDiagnosticCode =
  | 'identity_missing'
  | 'identity_stale'
  | 'session_id_missing'
  | 'session_file_missing'
  | 'cwd_missing'
  | 'cwd_unreadable'
  | 'not_git_repo'
  | 'git_lookup_failed'
  | 'detached_head'
  | 'branch_missing'
  | 'pr_missing'
  | 'pr_ambiguous'
  | 'pr_lookup_failed'
  | 'identity_write_error'
  | 'identity_read_error'
  | 'malformed_identity_record'
  | 'orphan_identity';

export interface IdentityDiagnostic {
  code: IdentityDiagnosticCode;
  message: string;
  runtimeId?: string;
  filePath?: string;
}

// ─── Identity freshness ─────────────────────────────────────────────

export type IdentityFreshness = 'fresh' | 'stale' | 'very_stale' | 'missing';

export interface IdentityFreshnessThresholds {
  freshAfterMs: number;
  staleAfterMs: number;
}

// ─── Joined session records ─────────────────────────────────────────

export interface JoinedSessionRecord {
  runtimeId: string;
  pid: number;
  presenceState: string;
  presenceReason?: string;
  heartbeatAt: string;
  heartbeatAgeMs: number;
  startedAt: string;

  // Identity fields (nullable)
  sessionId: string | null;
  sessionFile: string | null;
  sessionName: string | null;
  cwd: string | null;
  worktree: string | null;
  branch: string | null;
  prUrl: string | null;
  identityUpdatedAt: string | null;
  identityFreshness: IdentityFreshness;

  // Combined diagnostics
  diagnostics: JoinedDiagnostic[];
}

export interface JoinedDiagnostic {
  code: IdentityDiagnosticCode | PresenceDiagnosticCode;
  message: string;
  runtimeId?: string;
  filePath?: string;
}

export interface JoinedSessionView {
  records: JoinedSessionRecord[];
  diagnostics: JoinedDiagnostic[];
}

// ─── Git resolution ─────────────────────────────────────────────────

export interface GitResolvedInfo {
  worktree: string | null;
  branch: string | null;
  remote: string | null;
  root: string | null;
}

export interface PrLookupResult {
  prUrl: string | null;
  strategy: string;
  diagnostic?: IdentityDiagnosticCode;
}

export type GitExec = (
  cwd: string,
  ...args: string[]
) => Promise<{ stdout: string; exitCode: number }>;

export type GhExec = (cwd: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>;
