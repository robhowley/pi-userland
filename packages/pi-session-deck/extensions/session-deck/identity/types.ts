import type { PresenceDiagnosticCode } from '../presence/types.js';

// ─── Session manager ────────────────────────────────────────────────

// Raw session_start fields are Pi-owned. Preserve any non-empty string so
// newer Pi reason/mode values round-trip through session-deck unchanged.
export type SessionStartReason = string;

export type SessionStartMode = string;

export interface SessionStartMetadata {
  reason: SessionStartReason;
  previousSessionFile?: string;
  mode?: SessionStartMode;
  hasUI?: boolean;
}

export interface SessionHeaderMetadata {
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface SessionManagerLike {
  getSessionId: () => string | null;
  getSessionFile: () => string | null;
  getSessionName?: () => string | null | undefined;
  getCwd?: () => string | null | undefined;
  getSessionStart?: () => SessionStartMetadata | undefined;
  getHeader?: () => SessionHeaderMetadata | null | undefined;
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
  repoName: string | null;
  qualifiedRepoName: string | null;
  branch: string | null;
  prUrl: string | null;
  isLinkedWorktree: boolean | null;
  worktreeLabel: string | null;
  identityUpdatedAt: string;
  sessionStartedAt: string;
  gitRemote: string | null;
  gitRoot: string | null;
  identitySource: string;
  sessionStart?: SessionStartMetadata;
  sessionHeader?: SessionHeaderMetadata;
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

// ─── Derived session facets ───────────────────────────────────────

export type SessionPersistenceFacet = 'in_memory' | 'file_backed' | 'unknown';

export type SessionInteractivityFacet = 'interactive' | 'headless' | 'unknown';

export type SessionLifecycleFacet =
  | 'startup'
  | 'reload'
  | 'new'
  | 'resume'
  | 'fork'
  | 'other'
  | 'unknown';

export type SessionLineageFacet = 'root' | 'previous' | 'parent' | 'previous_and_parent' | 'unknown';

export type SessionIdentityStrengthFacet = 'strong' | 'weak' | 'missing' | 'conflicted';

export type SessionHeaderConsistencyFacet =
  | 'consistent'
  | 'indeterminate'
  | 'mismatch'
  | 'unavailable';

export interface SessionDerivedFacets {
  persistence: SessionPersistenceFacet;
  interactivity: SessionInteractivityFacet;
  lifecycle: SessionLifecycleFacet;
  lineage: SessionLineageFacet;
  identityStrength: SessionIdentityStrengthFacet;
  headerConsistency: SessionHeaderConsistencyFacet;
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
  repoName: string | null;
  qualifiedRepoName: string | null;
  branch: string | null;
  prUrl: string | null;
  isLinkedWorktree: boolean | null;
  worktreeLabel: string | null;
  identityUpdatedAt: string | null;
  identityFreshness: IdentityFreshness;
  derivedFacets?: SessionDerivedFacets;
  sessionStart?: SessionStartMetadata;
  sessionHeader?: SessionHeaderMetadata;

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
  repoName: string | null;
  qualifiedRepoName: string | null;
  isLinkedWorktree: boolean | null;
  worktreeLabel: string | null;
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
