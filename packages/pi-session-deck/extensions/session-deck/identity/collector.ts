import { resolveGitInfo, resolvePrUrl } from './git.js';
import type { GitExec, SessionIdentityRecord } from './types.js';

export interface IdentityCollectorOptions {
  runtimeId: string;
  sessionManager?: {
    getSessionId: () => string | null;
    getSessionFile: () => string | null;
  };
  now?: () => Date;
  cwd?: string;
  execGit?: GitExec;
  identitySource: string;
}

export async function collectSessionIdentity(
  runtimeId: string,
  options: IdentityCollectorOptions,
): Promise<SessionIdentityRecord> {
  const now = options.now ?? (() => new Date());
  const nowIso = now().toISOString();
  const cwd = options.cwd ?? process.cwd();

  const sessionId = options.sessionManager?.getSessionId() ?? null;
  const sessionFile = options.sessionManager?.getSessionFile() ?? null;

  // Resolve Git info
  const gitInfo = await resolveGitInfo(cwd, {
    ...(options.execGit === undefined ? {} : { execGit: options.execGit }),
  });

  // Resolve PR URL if we have worktree + branch
  let prUrl: string | null = null;
  if (gitInfo.worktree !== null && gitInfo.branch !== null) {
    const prResult = await resolvePrUrl(gitInfo.worktree, gitInfo.branch, {
      ...(options.execGit === undefined ? {} : { execGit: options.execGit }),
    });
    prUrl = prResult.prUrl;
  }

  return {
    runtimeId,
    sessionId,
    sessionFile,
    cwd,
    worktree: gitInfo.worktree,
    branch: gitInfo.branch,
    prUrl,
    identityUpdatedAt: nowIso,
    sessionStartedAt: nowIso,
    gitRemote: gitInfo.remote,
    gitRoot: gitInfo.root,
    identitySource: options.identitySource,
  };
}
