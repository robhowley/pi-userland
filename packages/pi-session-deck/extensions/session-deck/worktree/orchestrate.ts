import { normalizeLaunchAgentDirSelection } from './agent-dir.js';
import { applyGitWorktreePlan, planGitWorktree, type CreateGitWorktreeOptions } from './create.js';
import {
  launchDetachedTmuxPi,
  preflightDetachedTmuxPi,
  type LaunchDetachedTmuxPiOptions,
} from './launch.js';
import { resolveRepoIntent, type ResolveRepoIntentOptions } from './repo-intent.js';
import type {
  CreateWorktreeActionRequest,
  CreateWorktreeActionResult,
  CreateWorktreeLaunchAgentDir,
  CreateWorktreeLaunchMode,
  CreateWorktreeLaunchNotStarted,
  CreateWorktreeStatusReporter,
  LaunchPrereqFailure,
} from './types.js';

export interface OrchestrateCreateWorktreeOptions
  extends ResolveRepoIntentOptions, CreateGitWorktreeOptions, LaunchDetachedTmuxPiOptions {
  onStatus?: CreateWorktreeStatusReporter;
}

export async function orchestrateCreateWorktree(
  request: CreateWorktreeActionRequest,
  options: OrchestrateCreateWorktreeOptions = {},
): Promise<CreateWorktreeActionResult> {
  const validation = normalizeCreateWorktreeRequest(request);
  if (!validation.ok) {
    return {
      ok: false,
      status: 'failed',
      failurePhase: 'planning',
      worktree: {
        ok: false,
        reason: 'invalid-request',
        message: validation.message,
        recoverable: true,
      },
      launch: notStartedLaunch(),
    };
  }

  const normalizedRequest = validation.request;
  const repo = await resolveRepoIntent(normalizedRequest.repoIntent, options);
  if (!repo.ok) {
    return {
      ok: false,
      status: 'failed',
      failurePhase: 'planning',
      worktree: {
        ok: false,
        reason: repo.reason === 'ambiguous' ? 'repo-intent-ambiguous' : 'repo-intent-unresolved',
        message: repo.message,
        recoverable: true,
      },
      launch: notStartedLaunch(),
    };
  }

  const plan = await planGitWorktree(normalizedRequest, repo.repo, options);
  if (!plan.ok) {
    return {
      ok: false,
      status: 'failed',
      failurePhase: 'planning',
      worktree: plan,
      launch: notStartedLaunch(),
    };
  }

  const launchMode = getLaunchMode(normalizedRequest);
  if (launchMode !== 'none') {
    const preflight = await preflightDetachedTmuxPi(options);
    if (!preflight.ok) {
      return {
        ok: false,
        status: 'preflight-failed',
        failurePhase: 'preflight',
        preflight: toPreflightFailure(preflight.reason),
        worktree: { requested: false, status: 'not-started' },
        launch: notStartedLaunch(),
      };
    }
  }

  options.onStatus?.({ stage: 'creating-worktree', message: 'Creating worktree…' });
  const worktree = await applyGitWorktreePlan(plan, repo.repo, options);
  if (!worktree.ok) {
    return {
      ok: false,
      status: 'failed',
      failurePhase: 'worktree',
      worktree,
      launch: notStartedLaunch(),
    };
  }

  if (launchMode === 'none') {
    return {
      ok: true,
      status: worktree.status === 'created' ? 'worktree-created' : 'worktree-reused',
      worktree,
      launch: { requested: false, mode: 'none', status: 'not-requested' },
    };
  }

  options.onStatus?.({ stage: 'starting-pi', message: 'Starting Pi session in tmux…' });
  const launch = await launchDetachedTmuxPi(worktree, normalizedRequest.label, {
    ...options,
    agentDir: normalizedRequest.launch.agentDir,
  });
  if (!launch.ok) {
    return {
      ok: false,
      status: 'partial-launch-failed',
      failurePhase: 'launch',
      worktree,
      worktreeRetained: true,
      launch,
    };
  }

  return {
    ok: true,
    status: worktree.status === 'created' ? 'created-and-launched' : 'reused-and-launched',
    worktree,
    launch,
  };
}

type NormalizedCreateWorktreeActionRequest = CreateWorktreeActionRequest & {
  branchName: string;
  label: string;
  launch: {
    mode: CreateWorktreeLaunchMode;
    agentDir: CreateWorktreeLaunchAgentDir;
  };
};

function normalizeCreateWorktreeRequest(
  request: CreateWorktreeActionRequest,
): { ok: true; request: NormalizedCreateWorktreeActionRequest } | { ok: false; message: string } {
  if (typeof request.branchName !== 'string' || request.branchName.trim().length === 0) {
    return { ok: false, message: 'Branch name is required.' };
  }

  if (!Array.isArray(request.repoIntent?.candidateRuntimeIds)) {
    return { ok: false, message: 'Repo intent must include candidate runtime ids.' };
  }

  const launchMode = getLaunchMode(request);
  if (launchMode !== 'none' && launchMode !== 'tmux-detached') {
    return { ok: false, message: 'Unsupported launch mode.' };
  }

  const agentDir = normalizeLaunchAgentDirSelection(request.launch?.agentDir);
  if (!agentDir.ok) {
    return { ok: false, message: agentDir.message };
  }
  if (launchMode === 'none' && request.launch?.agentDir !== undefined) {
    return { ok: false, message: 'launch.agentDir requires tmux-detached launch mode.' };
  }

  const branchName = request.branchName.trim();
  return {
    ok: true,
    request: {
      ...request,
      branchName,
      label: branchName,
      launch: { mode: launchMode, agentDir: agentDir.agentDir },
    },
  };
}

function getLaunchMode(request: CreateWorktreeActionRequest): CreateWorktreeLaunchMode {
  return request.launch?.mode ?? 'tmux-detached';
}

function notStartedLaunch(): CreateWorktreeLaunchNotStarted {
  return { requested: false, mode: 'tmux-detached', status: 'not-started' };
}

function toPreflightFailure(reason: LaunchPrereqFailure['reason']): LaunchPrereqFailure {
  return {
    reason,
    recoverable: true,
    message:
      reason === 'tmux-unavailable'
        ? 'New Pi session requires tmux on PATH; no worktree was created.'
        : 'New Pi session requires the pi executable on PATH; no worktree was created.',
  };
}
