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

export interface SessionIterm2TerminalMetadata {
  kind: 'iterm2';
  sessionId: string;
  revealUrl: string;
  termProgram?: string;
  lcTerminal?: string;
  lcTerminalVersion?: string;
}

export interface SessionGhosttyTerminalMetadata {
  kind: 'ghostty';
  terminalId: string;
}

export interface SessionTmuxTerminalMetadata {
  kind: 'tmux';
  sessionName: string;
  socketPath?: string;
  socketName?: string;
  sessionId?: string;
  windowName?: string;
  windowId?: string;
  paneId?: string;
  windowIndex?: number;
  paneIndex?: number;
  panePid?: number;
  host?: SessionGhosttyTerminalMetadata;
}

export type SessionTerminalMetadata =
  | SessionIterm2TerminalMetadata
  | SessionGhosttyTerminalMetadata
  | SessionTmuxTerminalMetadata;

export type SessionRuntimeLaunchMode = 'tui' | 'rpc' | 'json' | 'print';

export interface SessionRuntimeProcessAncestorMetadata {
  pid: number;
  ppid?: number;
  processStartedAt?: string;
}

export interface SessionRuntimeProcessMetadata {
  pid: number;
  ppid?: number;
  processStartedAt?: string;
  ancestors: SessionRuntimeProcessAncestorMetadata[];
}

export interface SessionRuntimeLaunchMetadata {
  noSession: boolean;
  print: boolean;
  mode?: SessionRuntimeLaunchMode;
  sessionArgPresent: boolean;
  forkArgPresent: boolean;
}

export interface SessionRuntimeStdioMetadata {
  stdinTTY: boolean;
  stdoutTTY: boolean;
  stderrTTY: boolean;
}

export interface SessionRuntimeInheritedDeckRuntimeMetadata {
  runtimeId?: string;
  sessionId?: string;
  sessionFile?: string;
  startedAt?: string;
}

export interface SessionRuntimeSignalsMetadata {
  process?: SessionRuntimeProcessMetadata;
  launch?: SessionRuntimeLaunchMetadata;
  stdio?: SessionRuntimeStdioMetadata;
  inheritedDeckRuntime?: SessionRuntimeInheritedDeckRuntimeMetadata;
}

export interface SessionManagerLike {
  getSessionId: () => string | null;
  getSessionFile: () => string | null;
  getSessionName?: () => string | null | undefined;
  getCwd?: () => string | null | undefined;
  getSessionStart?: () => SessionStartMetadata | undefined;
  getHeader?: () => SessionHeaderMetadata | null | undefined;
  getTerminal?: () => SessionTerminalMetadata | undefined;
  getRuntimeSignals?: () => SessionRuntimeSignalsMetadata | undefined;
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
  terminal?: SessionTerminalMetadata;
  runtimeSignals?: SessionRuntimeSignalsMetadata;
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

export type SessionRowKindFacet =
  | 'durable_session'
  | 'ephemeral_runtime'
  | 'ephemeral_child_runtime'
  | 'unknown';

export type SessionInteractivityFacet = 'interactive' | 'headless' | 'unknown';

export type SessionLifecycleFacet =
  | 'startup'
  | 'reload'
  | 'new'
  | 'resume'
  | 'fork'
  | 'other'
  | 'unknown';

export type SessionLineageFacet =
  | 'root'
  | 'previous'
  | 'parent'
  | 'previous_and_parent'
  | 'unknown';

export type SessionIdentityStrengthFacet = 'strong' | 'weak' | 'missing' | 'conflicted';

export type SessionHeaderConsistencyFacet =
  | 'consistent'
  | 'indeterminate'
  | 'mismatch'
  | 'unavailable';

export type ChildRuntimeConfidence = 'none' | 'low' | 'medium' | 'high' | 'explicit' | 'unknown';

export type ChildRuntimeEvidenceCode =
  | 'explicit_header_parent'
  | 'inherited_deck_runtime'
  | 'process_ancestor_match'
  | 'started_during_parent_tool'
  | 'same_terminal'
  | 'headless_in_memory'
  | 'automation_input_source';

export interface ChildRuntimeEvidence {
  code: ChildRuntimeEvidenceCode;
  confidence: ChildRuntimeConfidence;
  parentRuntimeId?: string;
  parentSessionId?: string;
}

export interface ChildRuntimeFacet {
  candidate: boolean;
  confidence: ChildRuntimeConfidence;
  evidence: ChildRuntimeEvidence[];
  parentRuntimeId?: string;
  parentSessionId?: string;
}

export interface SessionDerivedFacets {
  persistence: SessionPersistenceFacet;
  rowKind: SessionRowKindFacet;
  interactivity: SessionInteractivityFacet;
  lifecycle: SessionLifecycleFacet;
  lineage: SessionLineageFacet;
  identityStrength: SessionIdentityStrengthFacet;
  headerConsistency: SessionHeaderConsistencyFacet;
  childRuntime?: ChildRuntimeFacet;
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
  terminal?: SessionTerminalMetadata;
  runtimeSignals?: SessionRuntimeSignalsMetadata;

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
