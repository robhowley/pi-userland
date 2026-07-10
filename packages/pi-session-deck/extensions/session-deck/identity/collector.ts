import { resolveGitInfo, resolvePrUrl } from './git.js';
import { normalizeSessionHeaderMetadata, normalizeSessionStartMetadata } from './metadata.js';
import type {
  GhExec,
  GitExec,
  IdentityDiagnostic,
  SessionIdentityRecord,
  SessionManagerLike,
} from './types.js';

export interface IdentityCollectorOptions {
  runtimeId: string;
  sessionManager?: SessionManagerLike;
  now?: () => Date;
  cwd?: string;
  execGit?: GitExec;
  execGhCli?: GhExec | null;
  identitySource: string;
  /**
   * Existing identity record to preserve sessionStartedAt across periodic refreshes.
   */
  existingRecord?: SessionIdentityRecord;
  /**
   * Optional diagnostic sink to emit diagnostics during collection.
   */
  onDiagnostic?: (diagnostic: IdentityDiagnostic) => void;
}

export async function collectSessionIdentity(
  runtimeId: string,
  options: IdentityCollectorOptions,
): Promise<SessionIdentityRecord> {
  const now = options.now ?? (() => new Date());
  const nowIso = now().toISOString();
  const cwd = resolveCollectorCwd(options);

  const diagnostics: IdentityDiagnostic[] = [];

  const sessionId = safeCall(() => options.sessionManager?.getSessionId(), null) ?? null;
  const sessionFile = safeCall(() => options.sessionManager?.getSessionFile(), null) ?? null;
  const sessionName = normalizeOptionalStringField(
    safeCall(() => options.sessionManager?.getSessionName?.(), null),
  );
  const sessionStart =
    normalizeSessionStartMetadata(
      safeCall(() => options.sessionManager?.getSessionStart?.(), null),
    ) ?? options.existingRecord?.sessionStart;
  const sessionHeader =
    normalizeSessionHeaderMetadata(safeCall(() => options.sessionManager?.getHeader?.(), null)) ??
    options.existingRecord?.sessionHeader;

  // Emit diagnostics for missing session fields
  if (sessionId === null) {
    diagnostics.push({
      code: 'session_id_missing',
      message: 'Session ID is null — sessionManager not available or not started',
      runtimeId,
    });
  }
  if (sessionFile === null) {
    diagnostics.push({
      code: 'session_file_missing',
      message: 'Session file is null — sessionManager not available or not started',
      runtimeId,
    });
  }

  // Preserve sessionStartedAt only when the refreshed identity still belongs to the same session.
  const existingSessionStartedAt = isSameSessionIdentity(
    options.existingRecord,
    sessionId,
    sessionFile,
  )
    ? (options.existingRecord?.sessionStartedAt ?? null)
    : null;
  const sessionStartedAt = existingSessionStartedAt ?? nowIso;

  // Resolve Git info
  const gitInfo = await resolveGitInfo(cwd, {
    ...(options.execGit === undefined ? {} : { execGit: options.execGit }),
  });

  // Emit diagnostics for Git resolution
  if (gitInfo.worktree === null) {
    diagnostics.push({
      code: 'not_git_repo',
      message: `Not a git repository: ${cwd}`,
      runtimeId,
    });
  } else if (gitInfo.branch === null) {
    diagnostics.push({
      code: 'detached_head',
      message: `Git HEAD is detached at ${gitInfo.worktree}`,
      runtimeId,
    });
  } else if (gitInfo.root === null) {
    diagnostics.push({
      code: 'git_lookup_failed',
      message: `Failed to resolve git root for ${gitInfo.worktree}`,
      runtimeId,
    });
  }

  // Resolve PR URL if we have worktree + branch
  let prUrl: string | null = null;
  if (gitInfo.worktree !== null && gitInfo.branch !== null) {
    const prResult = await resolvePrUrl(gitInfo.worktree, gitInfo.branch, {
      ...(options.execGit === undefined ? {} : { execGit: options.execGit }),
      ...(options.execGhCli === undefined ? {} : { execGhCli: options.execGhCli }),
    });
    prUrl = prResult.prUrl;

    if (prUrl === null && prResult.diagnostic !== undefined) {
      diagnostics.push({
        code: prResult.diagnostic,
        message: `PR URL lookup failed for ${gitInfo.branch} at ${gitInfo.worktree}: ${prResult.strategy}`,
        runtimeId,
      });
    }
  }

  // Emit diagnostics to the sink
  for (const d of diagnostics) {
    try {
      options.onDiagnostic?.(d);
    } catch {
      // Fail-open on diagnostic sink errors
    }
  }

  return {
    runtimeId,
    sessionId,
    sessionFile,
    ...(sessionName === undefined ? {} : { sessionName }),
    cwd,
    worktree: gitInfo.worktree,
    repoName: gitInfo.repoName,
    qualifiedRepoName: gitInfo.qualifiedRepoName,
    branch: gitInfo.branch,
    prUrl,
    isLinkedWorktree: gitInfo.isLinkedWorktree,
    worktreeLabel: gitInfo.worktreeLabel,
    identityUpdatedAt: nowIso,
    sessionStartedAt,
    gitRemote: gitInfo.remote,
    gitRoot: gitInfo.root,
    identitySource: options.identitySource,
    ...(sessionStart === undefined ? {} : { sessionStart }),
    ...(sessionHeader === undefined ? {} : { sessionHeader }),
    diagnostics,
  };
}

function safeCall<T>(callback: () => T, fallback: T): T {
  try {
    return callback();
  } catch {
    return fallback;
  }
}

function normalizeOptionalStringField(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }

  return undefined;
}

function isSameSessionIdentity(
  existingRecord: SessionIdentityRecord | undefined,
  sessionId: string | null,
  sessionFile: string | null,
): boolean {
  if (existingRecord === undefined) {
    return false;
  }

  if (sessionId !== null && existingRecord.sessionId !== sessionId) {
    return false;
  }

  if (sessionFile !== null && existingRecord.sessionFile !== sessionFile) {
    return false;
  }

  return sessionId !== null || sessionFile !== null;
}

function resolveCollectorCwd(options: IdentityCollectorOptions): string {
  return (
    normalizeOptionalStringField(safeCall(() => options.sessionManager?.getCwd?.(), null)) ??
    normalizeOptionalStringField(options.cwd) ??
    process.cwd()
  );
}
