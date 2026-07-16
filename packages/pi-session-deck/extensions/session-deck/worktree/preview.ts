import { resolveDefaultBaseRef } from './git.js';
import { resolveRepoIntent, type ResolveRepoIntentOptions } from './repo-intent.js';
import type { WorktreeBasePreviewRequest, WorktreeBasePreviewResult } from './types.js';

export type ResolveWorktreeBasePreviewOptions = ResolveRepoIntentOptions;

export async function resolveWorktreeBasePreview(
  request: WorktreeBasePreviewRequest,
  options: ResolveWorktreeBasePreviewOptions = {},
): Promise<WorktreeBasePreviewResult> {
  const repo = await resolveRepoIntent(request.repoIntent, options);
  if (!repo.ok) {
    return {
      ok: false,
      status: 'failed',
      reason: repo.reason === 'ambiguous' ? 'repo-intent-ambiguous' : 'repo-intent-unresolved',
      message: repo.message,
      recoverable: true,
    };
  }

  const baseResolution = await resolveDefaultBaseRef(repo.repo.primaryWorktreePath, options);
  return {
    ok: true,
    status: 'resolved',
    baseRef: baseResolution.baseRef,
    ...(baseResolution.warning === undefined ? {} : { warning: baseResolution.warning }),
  };
}
