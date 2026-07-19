import type {
  BrowserSafeCreateWorktreeLaunchResult,
  CreateWorktreeLaunchAgentDir,
  CreateWorktreeLaunchFailure,
  CreateWorktreeLaunchSuccess,
  LaunchPrereqFailure,
} from '../worktree/types.js';

export interface CreateSessionActionRequest {
  action: 'create-session';
  cwd: string;
  launch?: {
    mode: 'tmux-detached';
    agentDir?: CreateWorktreeLaunchAgentDir;
  };
}

export type CreateSessionFailureReason =
  | 'invalid-request'
  | 'invalid-cwd'
  | 'cwd-not-found'
  | 'cwd-not-directory'
  | 'cwd-unavailable';

export type CreateSessionActionResult =
  | {
      ok: true;
      status: 'launched' | 'reused-existing';
      cwd: string;
      launch: CreateWorktreeLaunchSuccess;
    }
  | {
      ok: false;
      status: 'failed';
      failurePhase: 'validation';
      reason: CreateSessionFailureReason;
      message: string;
      recoverable: true;
    }
  | {
      ok: false;
      status: 'preflight-failed';
      failurePhase: 'preflight';
      preflight: LaunchPrereqFailure;
      launch: { requested: false; mode: 'tmux-detached'; status: 'not-started' };
    }
  | {
      ok: false;
      status: 'launch-failed';
      failurePhase: 'launch';
      cwd: string;
      launch: CreateWorktreeLaunchFailure;
    };

export type BrowserSafeCreateSessionActionResult =
  | {
      ok: true;
      status: 'launched' | 'reused-existing';
      cwd: string;
      launch: Extract<BrowserSafeCreateWorktreeLaunchResult, { requested: true; ok: true }>;
    }
  | {
      ok: false;
      status: 'failed';
      failurePhase: 'validation';
      reason: CreateSessionFailureReason;
      message: string;
      recoverable: true;
    }
  | {
      ok: false;
      status: 'preflight-failed';
      failurePhase: 'preflight';
      preflight: LaunchPrereqFailure;
      launch: { requested: false; mode: 'tmux-detached'; status: 'not-started' };
    }
  | {
      ok: false;
      status: 'launch-failed';
      failurePhase: 'launch';
      cwd: string;
      launch: Extract<BrowserSafeCreateWorktreeLaunchResult, { requested: true; ok: false }>;
    };
