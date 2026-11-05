import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { StoredSource } from './checkpoints.js';
import { readSession, type SessionSnapshot, type Source, type SessionTree } from './evidence.js';

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
): DiscoveryResult {
  const warnings: string[] = [];
  let incomplete = false;
  const sources: Source[] = enrolled.map((source) => ({
    ...source,
    file: resolve(source.file),
  }));
  const newSources: Source[] = [];
  const snapshots: SessionSnapshot[] = [];
  const enrolledById = new Map(sources.map((source) => [source.sessionId, source]));
  const enrolledByFile = new Map(sources.map((source) => [resolve(source.file), source]));
  const candidates: Candidate[] = [];
  const blockedSessionIds = new Set<string>();
  const scan = scanFiles(sessionDir, scanAllProjects);
  warnings.push(...scan.warnings);
  incomplete = scan.incomplete;

  for (const file of scan.files) {
    const resolvedFile = resolve(file);
    try {
      if (!statSync(resolvedFile).isFile()) continue;
      candidates.push({ file: resolvedFile, tree: readSession(resolvedFile) });
    } catch (error) {
      incomplete = true;
      warnings.push(`${resolvedFile}: ${String(error)}`);
    }
  }

  const freshById = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const enrolledAtPath = enrolledByFile.get(candidate.file);
    if (enrolledAtPath) {
      if (enrolledAtPath.sessionId !== candidate.tree.sessionId) {
        incomplete = true;
        blockedSessionIds.add(enrolledAtPath.sessionId);
        warnings.push(
          `${candidate.file}: session header ID changed from ${enrolledAtPath.sessionId} to ${candidate.tree.sessionId}`,
        );
        continue;
      }
      snapshots.push({ source: enrolledAtPath, tree: candidate.tree });
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
    snapshots.push({ source, tree: candidate.tree });
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
