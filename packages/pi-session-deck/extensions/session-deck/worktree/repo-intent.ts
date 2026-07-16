import { readFile } from 'node:fs/promises';
import { getIdentityRecordPath } from '../identity/store.js';
import type { IdentityFileReader } from '../identity/reader.js';
import type { SessionIdentityRecord } from '../identity/types.js';
import { resolveGitCommonDir, resolveGitTopLevel, type GitCommandOptions } from './git.js';
import type { CreateWorktreeRepoIntent, CreateWorktreeResolvedRepo } from './types.js';

export type ResolveRepoIntentResult =
  | { ok: true; repo: CreateWorktreeResolvedRepo }
  | { ok: false; reason: 'unresolved' | 'ambiguous'; message: string };

export interface ResolveRepoIntentOptions extends GitCommandOptions {
  identityDirectory?: string;
  readFile?: IdentityFileReader;
}

interface CandidateRepo {
  runtimeId: string;
  repoName: string | null;
  qualifiedRepoName: string | null;
  primaryWorktreePath: string;
  commonGitDir: string;
}

export async function resolveRepoIntent(
  intent: CreateWorktreeRepoIntent,
  options: ResolveRepoIntentOptions = {},
): Promise<ResolveRepoIntentResult> {
  const runtimeIds = normalizeRuntimeIds(intent);
  if (runtimeIds.length === 0) {
    return {
      ok: false,
      reason: 'unresolved',
      message: 'Choose a named repo with at least one known Pi session before creating a worktree.',
    };
  }

  const candidates: CandidateRepo[] = [];
  for (const runtimeId of runtimeIds) {
    const identity = await readIdentityByRuntimeId(runtimeId, options);
    if (identity === null || !matchesIntent(identity, intent)) {
      continue;
    }

    const cwd = identity.cwd ?? identity.worktree ?? identity.gitRoot;
    if (cwd === null) {
      continue;
    }

    const [topLevel, commonGitDir] = await Promise.all([
      resolveGitTopLevel(cwd, options),
      resolveGitCommonDir(cwd, options),
    ]);
    if (topLevel === null || commonGitDir === null) {
      continue;
    }

    candidates.push({
      runtimeId,
      repoName: identity.repoName,
      qualifiedRepoName: identity.qualifiedRepoName,
      primaryWorktreePath: topLevel,
      commonGitDir,
    });
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: 'unresolved',
      message: 'No candidate session resolved to a fresh local Git repository.',
    };
  }

  const grouped = groupCandidatesByCommonGitDir(candidates);
  if (grouped.size > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      message:
        'The selected repo label maps to multiple local Git repositories. Switch to a more specific repo tab.',
    };
  }

  const repoCandidates = [...grouped.values()][0]!;
  const preferred = repoCandidates.find(
    (candidate) => candidate.runtimeId === intent.preferredRuntimeId,
  );
  const selected = preferred ?? repoCandidates[0]!;

  return {
    ok: true,
    repo: {
      repoName: selected.repoName,
      qualifiedRepoName: selected.qualifiedRepoName,
      primaryWorktreePath: selected.primaryWorktreePath,
      commonGitDir: selected.commonGitDir,
      candidateRuntimeIds: repoCandidates.map((candidate) => candidate.runtimeId),
    },
  };
}

async function readIdentityByRuntimeId(
  runtimeId: string,
  options: ResolveRepoIntentOptions,
): Promise<SessionIdentityRecord | null> {
  const path = getIdentityRecordPath(runtimeId, options.identityDirectory);
  const readFileImpl = (options.readFile ?? readFile) as IdentityFileReader;

  try {
    const raw = await readFileImpl(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isIdentityRecord(parsed) || parsed.runtimeId !== runtimeId) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function normalizeRuntimeIds(intent: CreateWorktreeRepoIntent): string[] {
  const runtimeIds = [
    ...(intent.preferredRuntimeId === undefined || intent.preferredRuntimeId === null
      ? []
      : [intent.preferredRuntimeId]),
    ...intent.candidateRuntimeIds,
  ];

  return [...new Set(runtimeIds.map((runtimeId) => runtimeId.trim()).filter(Boolean))];
}

function matchesIntent(identity: SessionIdentityRecord, intent: CreateWorktreeRepoIntent): boolean {
  if (intent.qualifiedRepoName !== undefined && intent.qualifiedRepoName !== null) {
    return identity.qualifiedRepoName === intent.qualifiedRepoName;
  }

  if (intent.repoName !== undefined && intent.repoName !== null) {
    return identity.repoName === intent.repoName;
  }

  return identity.qualifiedRepoName !== null || identity.repoName !== null;
}

function groupCandidatesByCommonGitDir(
  candidates: readonly CandidateRepo[],
): Map<string, CandidateRepo[]> {
  const grouped = new Map<string, CandidateRepo[]>();
  for (const candidate of candidates) {
    const bucket = grouped.get(candidate.commonGitDir) ?? [];
    bucket.push(candidate);
    grouped.set(candidate.commonGitDir, bucket);
  }
  return grouped;
}

function isIdentityRecord(candidate: unknown): candidate is SessionIdentityRecord {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    !Array.isArray(candidate) &&
    typeof (candidate as { runtimeId?: unknown }).runtimeId === 'string' &&
    'identityUpdatedAt' in candidate
  );
}
