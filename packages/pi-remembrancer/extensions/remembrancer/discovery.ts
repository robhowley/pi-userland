import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { StoredSource } from './checkpoints.js';
import {
  readSession,
  ReviewBudget,
  ReviewLimitError,
  type SessionSnapshot,
  type Source,
  type SessionTree,
} from './evidence.js';

export type DiscoveryResult = {
  sources: Source[];
  newSources: Source[];
  snapshots: SessionSnapshot[];
  warnings: string[];
  incomplete: boolean;
};

type Candidate = {
  file: string;
  tree: SessionTree;
};

type FileScan = {
  files: string[];
  warnings: string[];
  incomplete: boolean;
};

function sourceKey(source: Pick<Source, 'sessionId' | 'file'>): string {
  return `${source.sessionId}\u0000${resolve(source.file)}`;
}

function collisionWarning(sessionId: string, files: readonly string[]): string {
  return `Session ${sessionId} has multiple archive files: ${files.join(', ')}`;
}

function scanFiles(sessionDir: string, scanAllProjects: boolean): FileScan {
  const directory = resolve(sessionDir);
  const warnings: string[] = [];
  let incomplete = false;
  let files: string[] = [];

  if (!scanAllProjects) {
    try {
      files = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.name.endsWith('.jsonl') && entry.isFile())
        .map((entry) => join(directory, entry.name))
        .sort();
    } catch (error) {
      return {
        files: [],
        warnings: [`${directory}: unable to enumerate session archive: ${String(error)}`],
        incomplete: true,
      };
    }
    return { files, warnings, incomplete };
  }

  const root = resolve(directory, '..');
  let buckets;
  try {
    buckets = readdirSync(root, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() || entry.isSymbolicLink(),
    );
  } catch (error) {
    return {
      files: [],
      warnings: [`${root}: unable to enumerate session archive: ${String(error)}`],
      incomplete: true,
    };
  }

  for (const bucket of buckets) {
    const bucketPath = join(root, bucket.name);
    try {
      files.push(
        ...readdirSync(bucketPath)
          .filter((file) => file.endsWith('.jsonl'))
          .map((file) => join(bucketPath, file)),
      );
    } catch (error) {
      incomplete = true;
      warnings.push(`${bucketPath}: unable to enumerate session archive: ${String(error)}`);
    }
  }

  return { files: files.sort(), warnings, incomplete };
}

/**
 * Enumerate the active configured session directory for seed batches. Default
 * Pi storage is a cwd bucket, so scan its sibling buckets; custom storage is a
 * flat directory and is scanned directly. Ordinary reviews use enrollment only.
 */
export function discoverSources(
  sessionDir: string,
  enrolled: readonly StoredSource[],
  requestedSince: string | null,
  scanAllProjects = false,
  budget = new ReviewBudget(),
): DiscoveryResult {
  const warnings: string[] = [];
  let incomplete = false;
  const sources: Source[] = [];
  const newSources: Source[] = [];
  const snapshots: SessionSnapshot[] = [];
  const enrolledById = new Map<string, Source>();
  const enrolledByFile = new Map<string, Source[]>();
  const enrolledKeys = new Set<string>();
  const conflictingEnrolledPaths = new Set<string>();
  for (const source of enrolled) {
    const normalized = { ...source, file: resolve(source.file) };
    const key = sourceKey(normalized);
    if (enrolledKeys.has(key)) continue;
    enrolledKeys.add(key);
    const samePath = enrolledByFile.get(normalized.file) ?? [];
    if (samePath.some((candidate) => candidate.sessionId !== normalized.sessionId))
      conflictingEnrolledPaths.add(normalized.file);
    samePath.push(normalized);
    enrolledByFile.set(normalized.file, samePath);
    sources.push(normalized);
    enrolledById.set(normalized.sessionId, normalized);
  }
  const candidates: Candidate[] = [];
  const snapshotKeys = new Set<string>();
  const addSnapshot = (source: Source, tree: SessionTree) => {
    const key = sourceKey(source);
    if (snapshotKeys.has(key)) return;
    snapshotKeys.add(key);
    snapshots.push({ source, tree });
  };
  const blockedSessionIds = new Set<string>();
  const scan = scanFiles(sessionDir, scanAllProjects);
  warnings.push(...scan.warnings);
  incomplete = scan.incomplete;

  const candidatePaths = new Set<string>();
  for (const file of scan.files) {
    const resolvedFile = resolve(file);
    if (candidatePaths.has(resolvedFile)) continue;
    candidatePaths.add(resolvedFile);
    budget.reserveSource(resolvedFile);
    try {
      if (!statSync(resolvedFile).isFile()) continue;
      const tree = readSession(resolvedFile, budget.limits);
      budget.retain(tree);
      candidates.push({ file: resolvedFile, tree });
    } catch (error) {
      if (error instanceof ReviewLimitError) throw error;
      const enrolledSources = enrolledByFile.get(resolvedFile) ?? [];
      for (const enrolledSource of enrolledSources) blockedSessionIds.add(enrolledSource.sessionId);
      incomplete = true;
      warnings.push(`${resolvedFile}: ${String(error)}`);
    }
  }

  for (const path of conflictingEnrolledPaths) {
    if (candidatePaths.has(path)) continue;
    incomplete = true;
    const identities = (enrolledByFile.get(path) ?? []).map((source) => source.sessionId);
    warnings.push(`${path}: enrolled for multiple session IDs: ${identities.join(', ')}`);
  }

  const freshById = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const enrolledAtPath = enrolledByFile.get(candidate.file) ?? [];
    if (enrolledAtPath.length > 0) {
      for (const enrolledSource of enrolledAtPath) {
        if (enrolledSource.sessionId !== candidate.tree.sessionId) {
          incomplete = true;
          warnings.push(
            `${candidate.file}: session header ID changed from ${enrolledSource.sessionId} to ${candidate.tree.sessionId}`,
          );
        }
        addSnapshot(enrolledSource, candidate.tree);
      }
      continue;
    }

    const enrolledSource = enrolledById.get(candidate.tree.sessionId);
    if (enrolledSource) {
      incomplete = true;
      blockedSessionIds.add(candidate.tree.sessionId);
      warnings.push(
        collisionWarning(candidate.tree.sessionId, [enrolledSource.file, candidate.file]),
      );
      continue;
    }

    const group = freshById.get(candidate.tree.sessionId) ?? [];
    group.push(candidate);
    freshById.set(candidate.tree.sessionId, group);
  }

  for (const [sessionId, group] of freshById) {
    if (group.length !== 1) {
      incomplete = true;
      warnings.push(
        collisionWarning(
          sessionId,
          group.map((candidate) => candidate.file),
        ),
      );
      continue;
    }
    const candidate = group[0]!;
    const source: Source = {
      sessionId,
      file: candidate.file,
      seedSince: requestedSince,
    };
    sources.push(source);
    newSources.push(source);
    addSnapshot(source, candidate.tree);
  }

  const seen = new Set<string>();
  return {
    sources: sources.filter((source) => {
      if (blockedSessionIds.has(source.sessionId)) return false;
      const key = sourceKey(source);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    newSources,
    snapshots: snapshots.filter((snapshot) => !blockedSessionIds.has(snapshot.source.sessionId)),
    warnings,
    incomplete,
  };
}
