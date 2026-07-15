export type CreateWorktreeLaunchMode = 'none' | 'tmux-detached';

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

export interface CreateWorktreeResolvedRepo {
  repoName: string | null;
  qualifiedRepoName: string | null;
  primaryWorktreePath: string;
  commonGitDir: string;
  candidateRuntimeIds: string[];
}

export type CreateWorktreePhaseResult =
  | {
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
  | {
      ok: false;
      reason: CreateWorktreeFailureReason;
      message: string;
      recoverable: boolean;
    };

export type CreateWorktreeLaunchResult =
  | {
      requested: false;
      mode: 'none';
      status: 'not-requested';
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
      reason:
        | 'tmux-unavailable'
        | 'pi-command-unavailable'
        | 'tmux-name-collision'
        | 'spawn-failed'
        | 'presence-timeout';
      recoverable: true;
      message: string;
      manualCommand?: string;
    };

export type CreateWorktreeActionResult =
  | {
      ok: true;
      status:
        | 'worktree-created'
        | 'worktree-reused'
        | 'created-and-launched'
        | 'reused-and-launched';
      worktree: Extract<CreateWorktreePhaseResult, { ok: true }>;
      launch: CreateWorktreeLaunchResult;
    }
  | {
      ok: true;
      status: 'partial-launch-failed';
      worktree: Extract<CreateWorktreePhaseResult, { ok: true }>;
      launch: Extract<CreateWorktreeLaunchResult, { requested: true; ok: false }>;
    }
  | {
      ok: false;
      status: 'failed';
      worktree: Extract<CreateWorktreePhaseResult, { ok: false }>;
      launch: Extract<CreateWorktreeLaunchResult, { requested: false }>;
    };

export type BrowserSafeCreateWorktreePhaseResult =
  | Omit<Extract<CreateWorktreePhaseResult, { ok: true }>, 'path' | 'manualCommand'>
  | Extract<CreateWorktreePhaseResult, { ok: false }>;

export type BrowserSafeCreateWorktreeLaunchResult =
  | Extract<CreateWorktreeLaunchResult, { requested: false }>
  | Omit<
      Extract<CreateWorktreeLaunchResult, { requested: true; ok: true }>,
      'tmuxSessionName' | 'tmuxTarget' | 'manualAttachCommand'
    >
  | Omit<Extract<CreateWorktreeLaunchResult, { requested: true; ok: false }>, 'manualCommand'>;

export type BrowserSafeCreateWorktreeActionResult =
  | {
      ok: true;
      status:
        | 'worktree-created'
        | 'worktree-reused'
        | 'created-and-launched'
        | 'reused-and-launched';
      worktree: Extract<BrowserSafeCreateWorktreePhaseResult, { ok: true }>;
      launch: BrowserSafeCreateWorktreeLaunchResult;
    }
  | {
      ok: true;
      status: 'partial-launch-failed';
      worktree: Extract<BrowserSafeCreateWorktreePhaseResult, { ok: true }>;
      launch: Extract<BrowserSafeCreateWorktreeLaunchResult, { requested: true; ok: false }>;
    }
  | {
      ok: false;
      status: 'failed';
      worktree: Extract<BrowserSafeCreateWorktreePhaseResult, { ok: false }>;
      launch: Extract<BrowserSafeCreateWorktreeLaunchResult, { requested: false }>;
    };

export interface CreateWorktreeStatusUpdate {
  stage: 'creating-worktree' | 'starting-pi' | 'waiting-for-session';
  message: string;
}

export type CreateWorktreeStatusReporter = (update: CreateWorktreeStatusUpdate) => void;
