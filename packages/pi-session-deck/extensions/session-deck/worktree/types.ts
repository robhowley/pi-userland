export type CreateWorktreeLaunchMode = 'none' | 'tmux-detached';
export type CreateWorktreeLaunchAgentDirMode = 'ambient' | 'default' | 'custom';

export type CreateWorktreeLaunchAgentDir =
  | { mode: 'ambient'; customDir?: never }
  | { mode: 'default'; customDir?: never }
  | { mode: 'custom'; customDir: string };

export type WorktreeLaunchContextEnvAction = 'inherit' | 'unset' | 'set';
export type WorktreeLaunchContextProvenance =
  | 'request'
  | 'tmux-server-env'
  | 'process-env'
  | 'pi-default'
  | 'unknown';

export interface WorktreeLaunchContextPreviewRequest {
  agentDir?: CreateWorktreeLaunchAgentDir;
}

export type WorktreeLaunchContextPreviewResult =
  | {
      ok: true;
      status: 'resolved';
      mode: CreateWorktreeLaunchAgentDirMode;
      envAction: WorktreeLaunchContextEnvAction;
      effectiveDisplay: string;
      provenance: WorktreeLaunchContextProvenance;
      warnings: string[];
    }
  | {
      ok: false;
      status: 'failed';
      reason: 'invalid-request';
      message: string;
      recoverable: true;
    };

export type BrowserSafeWorktreeLaunchContextPreviewResult = WorktreeLaunchContextPreviewResult;

export interface CreateWorktreeRepoIntent {
  qualifiedRepoName?: string | null;
  repoName?: string | null;
  candidateRuntimeIds: string[];
  preferredRuntimeId?: string | null;
}

export interface CreateWorktreeActionRequest {
  repoIntent: CreateWorktreeRepoIntent;
  branchName: string;
  baseRef?: string;
  path?: string;
  launch?: {
    mode: CreateWorktreeLaunchMode;
    agentDir?: CreateWorktreeLaunchAgentDir;
  };
}

export interface WorktreeBasePreviewRequest {
  repoIntent: CreateWorktreeRepoIntent;
}

export type WorktreeBasePreviewResult =
  | {
      ok: true;
      status: 'resolved';
      baseRef: string;
      warning?: string;
    }
  | {
      ok: false;
      status: 'failed';
      reason: 'repo-intent-unresolved' | 'repo-intent-ambiguous';
      message: string;
      recoverable: true;
    };

export type BrowserSafeWorktreeBasePreviewResult = WorktreeBasePreviewResult;

export type CreateWorktreeFailureReason =
  | 'invalid-request'
  | 'repo-intent-unresolved'
  | 'repo-intent-ambiguous'
  | 'invalid-label'
  | 'invalid-branch'
  | 'invalid-base-ref'
  | 'path-collision'
  | 'branch-collision'
  | 'git-failed'
  | 'lock-busy';

export type LaunchPrereqFailureReason = 'tmux-unavailable' | 'pi-command-unavailable';

export type CreateWorktreeLaunchFailureReason =
  | LaunchPrereqFailureReason
  | 'tmux-name-collision'
  | 'launch-context-mismatch'
  | 'spawn-failed'
  | 'presence-timeout';

export interface CreateWorktreeResolvedRepo {
  repoName: string | null;
  qualifiedRepoName: string | null;
  primaryWorktreePath: string;
  commonGitDir: string;
  candidateRuntimeIds: string[];
}

export interface CreateWorktreeSuccess {
  ok: true;
  status: 'created' | 'reused';
  path: string;
  branch: string;
  baseRef: string;
  repoName: string | null;
  qualifiedRepoName: string | null;
  warning?: string;
  manualCommand: string;
}

export interface CreateWorktreeFailure {
  ok: false;
  reason: CreateWorktreeFailureReason;
  message: string;
  recoverable: boolean;
}

export type CreateWorktreePhaseResult = CreateWorktreeSuccess | CreateWorktreeFailure;

export interface LaunchPrereqFailure {
  reason: LaunchPrereqFailureReason;
  recoverable: true;
  message: string;
}

export type CreateWorktreeLaunchResult =
  | {
      requested: false;
      mode: 'none';
      status: 'not-requested';
    }
  | {
      requested: false;
      mode: 'tmux-detached';
      status: 'not-started';
    }
  | {
      requested: true;
      ok: true;
      mode: 'tmux-detached';
      status: 'launched' | 'reused-existing' | 'requested-unobserved';
      tmuxSessionName: string;
      tmuxTarget: string;
      runtimeId?: string;
      sessionId?: string | null;
      message: string;
      warning?: string;
      manualAttachCommand: string;
    }
  | {
      requested: true;
      ok: false;
      mode: 'tmux-detached';
      status: 'failed';
      reason: CreateWorktreeLaunchFailureReason;
      recoverable: true;
      message: string;
      manualCommand?: string;
    };

export type CreateWorktreeLaunchNotStarted = Extract<
  CreateWorktreeLaunchResult,
  { requested: false }
>;
export type CreateWorktreeLaunchSuccess = Extract<
  CreateWorktreeLaunchResult,
  { requested: true; ok: true }
>;
export type CreateWorktreeLaunchFailure = Extract<
  CreateWorktreeLaunchResult,
  { requested: true; ok: false }
>;

export type CreateWorktreeActionResult =
  | {
      ok: true;
      status: 'worktree-created' | 'worktree-reused';
      worktree: CreateWorktreeSuccess;
      launch: Extract<CreateWorktreeLaunchResult, { requested: false; mode: 'none' }>;
    }
  | {
      ok: true;
      status: 'created-and-launched' | 'reused-and-launched';
      worktree: CreateWorktreeSuccess;
      launch: CreateWorktreeLaunchSuccess;
    }
  | {
      ok: false;
      status: 'preflight-failed';
      failurePhase: 'preflight';
      preflight: LaunchPrereqFailure;
      worktree: { requested: false; status: 'not-started' };
      launch: CreateWorktreeLaunchNotStarted;
    }
  | {
      ok: false;
      status: 'failed';
      failurePhase: 'planning' | 'worktree';
      worktree: CreateWorktreeFailure;
      launch: CreateWorktreeLaunchNotStarted;
    }
  | {
      ok: false;
      status: 'partial-launch-failed';
      failurePhase: 'launch';
      worktree: CreateWorktreeSuccess;
      worktreeRetained: true;
      launch: CreateWorktreeLaunchFailure;
    };

export type BrowserSafeCreateWorktreePhaseResult =
  | Omit<CreateWorktreeSuccess, 'path' | 'manualCommand'>
  | CreateWorktreeFailure;

export type BrowserSafeCreateWorktreeLaunchResult =
  | CreateWorktreeLaunchNotStarted
  | Omit<CreateWorktreeLaunchSuccess, 'tmuxSessionName' | 'tmuxTarget' | 'manualAttachCommand'>
  | Omit<CreateWorktreeLaunchFailure, 'manualCommand'>;

export type BrowserSafeCreateWorktreeActionResult =
  | {
      ok: true;
      status: 'worktree-created' | 'worktree-reused';
      worktree: Extract<BrowserSafeCreateWorktreePhaseResult, { ok: true }>;
      launch: Extract<BrowserSafeCreateWorktreeLaunchResult, { requested: false; mode: 'none' }>;
    }
  | {
      ok: true;
      status: 'created-and-launched' | 'reused-and-launched';
      worktree: Extract<BrowserSafeCreateWorktreePhaseResult, { ok: true }>;
      launch: Extract<BrowserSafeCreateWorktreeLaunchResult, { requested: true; ok: true }>;
    }
  | {
      ok: false;
      status: 'preflight-failed';
      failurePhase: 'preflight';
      preflight: LaunchPrereqFailure;
      worktree: { requested: false; status: 'not-started' };
      launch: Extract<BrowserSafeCreateWorktreeLaunchResult, { requested: false }>;
    }
  | {
      ok: false;
      status: 'failed';
      failurePhase: 'planning' | 'worktree';
      worktree: Extract<BrowserSafeCreateWorktreePhaseResult, { ok: false }>;
      launch: Extract<BrowserSafeCreateWorktreeLaunchResult, { requested: false }>;
    }
  | {
      ok: false;
      status: 'partial-launch-failed';
      failurePhase: 'launch';
      worktree: Extract<BrowserSafeCreateWorktreePhaseResult, { ok: true }>;
      worktreeRetained: true;
      launch: Extract<BrowserSafeCreateWorktreeLaunchResult, { requested: true; ok: false }>;
    };

export interface CreateWorktreeStatusUpdate {
  stage: 'creating-worktree' | 'starting-pi';
  message: string;
}

export type CreateWorktreeStatusReporter = (update: CreateWorktreeStatusUpdate) => void;
