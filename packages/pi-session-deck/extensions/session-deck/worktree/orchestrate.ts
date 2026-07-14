import { createGitWorktree, type CreateGitWorktreeOptions } from './create.js';
import { launchDetachedTmuxPi, type LaunchDetachedTmuxPiOptions } from './launch.js';
import { resolveRepoIntent, type ResolveRepoIntentOptions } from './repo-intent.js';
import type {
  CreateWorktreeActionRequest,
  CreateWorktreeActionResult,
  CreateWorktreeLaunchMode,
  CreateWorktreeStatusReporter,
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
      worktree: {
        ok: false,
        reason: 'invalid-request',
        message: validation.message,
        recoverable: true,
      },
      launch: { requested: false, mode: 'none', status: 'not-requested' },
    };
  }

  const normalizedRequest = validation.request;
  const repo = await resolveRepoIntent(normalizedRequest.repoIntent, options);
  if (!repo.ok) {
    return {
      ok: false,
      status: 'failed',
      worktree: {
        ok: false,
        reason: repo.reason === 'ambiguous' ? 'repo-intent-ambiguous' : 'repo-intent-unresolved',
        message: repo.message,
        recoverable: true,
      },
      launch: { requested: false, mode: 'none', status: 'not-requested' },
    };
  }

  options.onStatus?.({ stage: 'creating-worktree', message: 'Creating worktree…' });
  const worktree = await createGitWorktree(normalizedRequest, repo.repo, options);
  if (!worktree.ok) {
    return {
      ok: false,
      status: 'failed',
      worktree,
      launch: { requested: false, mode: 'none', status: 'not-requested' },
    };
  }

  const launchMode = getLaunchMode(normalizedRequest);
  if (launchMode === 'none') {
    return {
      ok: true,
      status: worktree.status === 'created' ? 'worktree-created' : 'worktree-reused',
      worktree,
      launch: { requested: false, mode: 'none', status: 'not-requested' },
    };
  }

  options.onStatus?.({ stage: 'starting-pi', message: 'Starting Pi session in tmux…' });
  options.onStatus?.({
    stage: 'waiting-for-session',
    message: 'Waiting for session to appear in Session Deck…',
  });
  const launch = await launchDetachedTmuxPi(worktree, normalizedRequest.label, options);
  if (launch.requested && !launch.ok) {
    return {
      ok: true,
      status: 'partial-launch-failed',
      worktree,
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
};

function normalizeCreateWorktreeRequest(
  request: CreateWorktreeActionRequest,
): { ok: true; request: NormalizedCreateWorktreeActionRequest } | { ok: false; message: string } {
  if (typeof request.branchName !== 'string' || request.branchName.trim().length === 0) {
    return { ok: false, message: 'Branch name is required.' };
  }

  if (!Array.isArray(request.repoIntent.candidateRuntimeIds)) {
    return { ok: false, message: 'Repo intent must include candidate runtime ids.' };
  }

  const launchMode = getLaunchMode(request);
  if (launchMode !== 'none' && launchMode !== 'tmux-detached') {
    return { ok: false, message: 'Unsupported launch mode.' };
  }

  const branchName = request.branchName.trim();
  return {
    ok: true,
    request: {
      ...request,
      branchName,
      label: branchName,
    },
  };
}

function getLaunchMode(request: CreateWorktreeActionRequest): CreateWorktreeLaunchMode {
  return request.launch?.mode ?? 'tmux-detached';
}
