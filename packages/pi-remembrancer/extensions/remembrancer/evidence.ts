import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export type Tip = { file: string; sessionId: string; entryId: string };
export type Checkpoint = Tip & { since: string | null };
export type Source = Pick<Tip, 'sessionId' | 'file'> & { seedSince?: string | null };
export type SeedDefault = { sessionId: string; since: string };
export type Evidence = Tip & {
  role: string;
  text: string;
  cwd: string;
  timestamp: string;
  branchId: string;
  reviewedThrough: string | null;
  editId: string | null;
};
export type ReviewOptions = {
  requestedSince?: string | null;
  seed?: string;
  now?: Date | string | number;
};
export type PreparedReview = {
  tips: Tip[];
  checkpoints: Checkpoint[];
  sourceDefaults: SeedDefault[];
  evidence: Evidence[];
  snapshots: SessionSnapshot[];
  successfulSources: Source[];
  warnings: string[];
  incomplete: boolean;
  coverageChanged: boolean;
};
type Entry = {
  id: string;
  parentId: string | null;
  type: string;
  timestamp?: unknown;
  message?: { role?: string; content?: unknown };
  targetId?: string;
  replacement?: { content?: unknown } | null;
};

const DAY_MS = 86_400_000;

function timestampText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function timestampMillis(value: string): number | null {
  if (!value) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function absoluteTimestamp(value: string): string {
  const milliseconds = timestampMillis(value);
  if (milliseconds === null) throw new Error(`Invalid review timestamp: ${value}`);
  return new Date(milliseconds).toISOString();
}

function earlierFinite(
  existing: string | null | undefined,
  requested: string | null,
): string | null {
  if (requested === null) return existing ?? null;
  if (existing === undefined || existing === null) return requested;
  return existing < requested ? existing : requested;
}

function checkpointSince(
  checkpoint: Checkpoint | undefined,
  source: Source,
  requested: string | null,
) {
  if (checkpoint) {
    if (checkpoint.since === null) return null;
    return earlierFinite(checkpoint.since, requested);
  }
  return earlierFinite(source.seedSince, requested);
}

function isEligible(item: Evidence, since: string | null): boolean {
  if (since === null) return true;
  const itemTime = timestampMillis(item.timestamp);
  return itemTime === null || itemTime >= Date.parse(since);
}

function selectionKey(item: Evidence): string {
  return `${item.entryId}\u0000${item.editId ?? ''}`;
}

function sourceKey(source: Pick<Source, 'sessionId' | 'file'>): string {
  return `${source.sessionId}\u0000${resolve(source.file)}`;
}

function normalizedOptions(options?: ReviewOptions | string): { requestedSince: string | null } {
  if (typeof options === 'string') return { requestedSince: absoluteTimestamp(options) };
  if (!options) return { requestedSince: null };
  if (options.seed !== undefined && options.requestedSince !== undefined)
    throw new Error('Use either seed or requestedSince, not both');
  if (options.seed !== undefined)
    return { requestedSince: resolveSeedSince(options.seed, options.now ?? new Date()) };
  return {
    requestedSince:
      options.requestedSince === undefined || options.requestedSince === null
        ? null
        : absoluteTimestamp(options.requestedSince),
  };
}

export function resolveSeedSince(
  duration: string,
  now: Date | string | number = new Date(),
): string {
  const match = /^([1-9]\d*)d$/.exec(duration);
  if (!match) throw new Error('Seed duration must be a positive integer such as 14d');
  const days = Number(match[1]);
  if (!Number.isSafeInteger(days) || days > Math.floor(Number.MAX_SAFE_INTEGER / DAY_MS))
    throw new Error('Seed duration is out of range');

  const nowMilliseconds =
    now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(nowMilliseconds)) throw new Error('Seed start requires a valid UTC clock');
  const sinceMilliseconds = nowMilliseconds - days * DAY_MS;
  if (!Number.isFinite(sinceMilliseconds)) throw new Error('Seed duration is out of range');
  const since = new Date(sinceMilliseconds);
  if (Number.isNaN(since.getTime())) throw new Error('Seed duration is out of range');
  return since.toISOString();
}

// Internal limits, injectable only for isolated tests. Text and compact-data
// limits use UTF-8 string bytes plus small fixed slots; raw payloads exist for
// only one record at a time.
export const REVIEW_LIMITS = {
  recordBytes: 32 * 1024 * 1024,
  sourceEntries: 20_000,
  sourceBytes: 8 * 1024 * 1024,
  sourceTextBytes: 4 * 1024 * 1024,
  sourceBranches: 512,
  sourceBranchEntries: 100_000,
  totalEntries: 300_000,
  totalBytes: 64 * 1024 * 1024,
  totalTextBytes: 32 * 1024 * 1024,
  totalBranchEntries: 1_000_000,
  sources: 2048,
};
export type ReviewLimits = typeof REVIEW_LIMITS;
export class ReviewLimitError extends Error {}

const COMPACT_HEADER_BYTES = 32;
const COMPACT_ENTRY_BYTES = 64;

function stringBytes(value: unknown): number {
  return typeof value === 'string' ? Buffer.byteLength(value) : 0;
}

function compactEntryBytes(entry: Entry): number {
  let bytes =
    COMPACT_ENTRY_BYTES +
    stringBytes(entry.id) +
    stringBytes(entry.parentId) +
    stringBytes(entry.type) +
    stringBytes(entry.timestamp);
  if (entry.message)
    bytes +=
      COMPACT_ENTRY_BYTES + stringBytes(entry.message.role) + stringBytes(entry.message.content);
  if (entry.targetId) bytes += COMPACT_ENTRY_BYTES + stringBytes(entry.targetId);
  if (entry.replacement) bytes += COMPACT_ENTRY_BYTES + stringBytes(entry.replacement.content);
  return bytes;
}

export class ReviewBudget {
  readonly limits: ReviewLimits;
  private trees = new WeakSet<SessionTree>();
  private sourcePaths = new Set<string>();
  private entries = 0;
  private bytes = 0;
  private textBytes = 0;
  private branches = 0;
  constructor(limits: Partial<ReviewLimits> = {}) {
    this.limits = { ...REVIEW_LIMITS, ...limits };
  }
  reserveSource(file: string) {
    const path = resolve(file);
    if (this.sourcePaths.has(path)) return;
    if (this.sourcePaths.size >= this.limits.sources)
      throw new ReviewLimitError('Aggregate review source limit exceeded');
    this.sourcePaths.add(path);
  }
  retain(tree: SessionTree) {
    if (this.trees.has(tree)) return;
    this.entries += tree.entries.size;
    this.bytes += tree.bytes;
    this.textBytes += tree.textBytes;
    if (
      this.entries > this.limits.totalEntries ||
      this.bytes > this.limits.totalBytes ||
      this.textBytes > this.limits.totalTextBytes
    )
      throw new ReviewLimitError('Aggregate review snapshot limit exceeded');
    this.trees.add(tree);
  }
  review(tree: SessionTree) {
    // Three walks cover ancestor lookup, previous evidence and current evidence.
    // This also bounds descriptors, selection keys and unknown-time warnings.
    this.branches += tree.branchEntries * 3;
    if (this.branches > this.limits.totalBranchEntries)
      throw new ReviewLimitError('Aggregate review branch/evidence limit exceeded');
  }
}

function visibleText(content: unknown, maxBytes = Number.POSITIVE_INFINITY): string {
  if (typeof content === 'string') {
    if (Buffer.byteLength(content) > maxBytes)
      throw Error('Session retained text/metadata limit exceeded');
    return content;
  }
  if (!Array.isArray(content)) return '';

  const texts: string[] = [];
  let bytes = 0;
  for (const block of content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue;
    bytes += Buffer.byteLength(block.text) + (texts.length > 0 ? 1 : 0);
    if (bytes > maxBytes) throw Error('Session retained text/metadata limit exceeded');
    texts.push(block.text);
  }
  return texts.join('\n');
}

/** Read only the opening extent. Verify its bytes again without retaining them. */
function readRecords(file: string, limit: number, consume: (line: string, number: number) => void) {
  const fd = openSync(file, 'r');
  try {
    const initial = fstatSync(fd);
    if (!initial.isFile()) throw Error('Session source is not a regular file');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let parts: Buffer[] = [];
    let length = 0;
    let lineNumber = 1;
    const hash = createHash('sha256');
    for (let position = 0; position < initial.size; ) {
      const count = readSync(
        fd,
        chunk,
        0,
        Math.min(chunk.length, initial.size - position),
        position,
      );
      if (!count) throw Error('Session source truncated during read');
      position += count;
      hash.update(chunk.subarray(0, count));
      let start = 0;
      while (start < count) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 || newline >= count ? count : newline;
        const size = end - start;
        if (length + size > limit) throw Error('Session raw record limit exceeded');
        if (size) parts.push(Buffer.from(chunk.subarray(start, end)));
        length += size;
        if (end < count) {
          consume(Buffer.concat(parts, length).toString('utf8'), lineNumber++);
          parts = [];
          length = 0;
        }
        start = end + 1;
      }
    }
    if (length) consume(Buffer.concat(parts, length).toString('utf8'), lineNumber);
    parts = [];
    const verify = createHash('sha256');
    for (let position = 0; position < initial.size; ) {
      const count = readSync(
        fd,
        chunk,
        0,
        Math.min(chunk.length, initial.size - position),
        position,
      );
      if (!count) throw Error('Session source truncated during verification');
      verify.update(chunk.subarray(0, count));
      position += count;
    }
    const final = fstatSync(fd);
    const path = statSync(file);
    if (
      final.size < initial.size ||
      path.dev !== initial.dev ||
      path.ino !== initial.ino ||
      hash.digest('hex') !== verify.digest('hex') ||
      (final.size === initial.size &&
        (final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs))
    )
      throw Error('Session source changed during read');
  } finally {
    closeSync(fd);
  }
}

export function readSession(file: string, limits: ReviewLimits = REVIEW_LIMITS) {
  let header: { type?: string; id?: unknown; cwd?: unknown } = {};
  const entries = new Map<string, Entry>();
  const leaves = new Set<string>();
  const depths = new Map<string, number>();
  let bytes = 0;
  let textBytes = 0;
  const bounded = (value: string, max = 256) => {
    if (Buffer.byteLength(value) > max) throw Error('Session metadata limit exceeded');
    return value;
  };
  readRecords(file, limits.recordBytes, (line, lineNumber) => {
    if (lineNumber === 1) {
      const raw = JSON.parse(line || '{}');
      header = {
        type: raw?.type,
        id: raw?.id,
        cwd: typeof raw?.cwd === 'string' ? raw.cwd : undefined,
      };
      if (header?.type !== 'session' || typeof header.id !== 'string' || !header.id.trim())
        throw Error(`Invalid session header in ${file}`);
      bounded(header.id);
      if (typeof header.cwd === 'string') bounded(header.cwd, 16 * 1024);
      bytes += COMPACT_HEADER_BYTES + stringBytes(header.id) + stringBytes(header.cwd);
      if (bytes > limits.sourceBytes) throw Error('Session retained text/metadata limit exceeded');
      return;
    }
    if (!line.trim()) return;
    let e: Entry;
    try {
      e = JSON.parse(line) as Entry;
    } catch (error) {
      throw Error(`Invalid JSON at ${file}:${lineNumber}`, { cause: error });
    }
    if (
      !e ||
      typeof e.id !== 'string' ||
      !e.id ||
      typeof e.type !== 'string' ||
      entries.has(e.id) ||
      !(e.parentId === null || entries.has(e.parentId))
    )
      throw Error(`Invalid session tree at ${file}:${lineNumber}`);
    if (entries.size >= limits.sourceEntries) throw Error('Session entry limit exceeded');
    const compact: Entry = {
      id: bounded(e.id),
      parentId: e.parentId,
      type: bounded(e.type),
      timestamp: bounded(timestampText(e.timestamp)),
    };
    const projectText = (content: unknown) => {
      const text = visibleText(content, limits.sourceTextBytes - textBytes);
      textBytes += Buffer.byteLength(text);
      return text;
    };
    if (e.type === 'message' && (e.message?.role === 'user' || e.message?.role === 'assistant'))
      compact.message = { role: e.message.role, content: projectText(e.message.content) };
    if (e.type === 'context_edit') {
      if (typeof e.targetId === 'string') compact.targetId = bounded(e.targetId);
      compact.replacement =
        e.replacement === null || e.replacement === undefined
          ? null
          : { content: projectText(e.replacement.content) };
    }
    bytes += compactEntryBytes(compact);
    if (bytes > limits.sourceBytes) throw Error('Session retained text/metadata limit exceeded');
    entries.set(compact.id, compact);
    depths.set(compact.id, (compact.parentId === null ? 0 : depths.get(compact.parentId)!) + 1);
    if (compact.parentId) leaves.delete(compact.parentId);
    leaves.add(compact.id);
  });
  if (header?.type !== 'session' || typeof header.id !== 'string' || header.id.trim() === '')
    throw Error(`Invalid session header in ${file}`);
  const branchEntries = [...leaves].reduce((sum, id) => sum + depths.get(id)!, 0);
  if (leaves.size > limits.sourceBranches || branchEntries * 3 > limits.sourceBranchEntries)
    throw Error('Session branch/evidence limit exceeded');
  const tips: Tip[] = [...leaves].map((entryId) => ({
    file: resolve(file),
    sessionId: header.id as string,
    entryId,
  }));
  return {
    sessionId: header.id as string,
    cwd: typeof header.cwd === 'string' && header.cwd.trim() ? String(header.cwd) : '(unknown)',
    entries,
    tips,
    bytes,
    textBytes,
    branchEntries,
  };
}

export type SessionTree = ReturnType<typeof readSession>;
export type SessionSnapshot = { source: Source; tree: SessionTree };

/** Include only visible user and assistant text on the immutable path to tip. */
export function branchEvidence(
  tree: SessionTree,
  tip: Tip,
  reviewedThrough: string | null = null,
): Evidence[] {
  if (tip.sessionId !== tree.sessionId || !tree.entries.has(tip.entryId))
    throw Error('Unknown review boundary');
  const evidence: Evidence[] = [];
  const edits = new Map<string, Entry>();
  let id: string | null = tip.entryId;
  while (id !== null) {
    const e: Entry = tree.entries.get(id)!;
    id = e.parentId;
    if (e.type === 'context_edit' && e.targetId && !edits.has(e.targetId)) edits.set(e.targetId, e);
    const edit = edits.get(e.id);
    edits.delete(e.id);
    const role = e.message?.role;
    if (e.type !== 'message' || (role !== 'user' && role !== 'assistant')) continue;
    const content = edit ? edit.replacement?.content : e.message?.content;
    const text = visibleText(content);
    if (!text) continue;
    evidence.push({
      ...tip,
      entryId: e.id,
      role,
      text,
      cwd: tree.cwd,
      timestamp: timestampText(edit ? edit.timestamp : e.timestamp),
      branchId: tip.entryId,
      reviewedThrough,
      editId: edit?.id ?? null,
    });
  }
  return evidence.reverse();
}

/** Read each source once, then freeze branch evidence and finish boundaries. */
export function prepareReview(
  sources: readonly Source[],
  reviewed: readonly (Tip | Checkpoint)[],
  options?: ReviewOptions | string,
  snapshots: readonly SessionSnapshot[] = [],
  budget = new ReviewBudget(),
): PreparedReview {
  const { requestedSince } = normalizedOptions(options);
  const tips: Tip[] = [];
  const checkpoints: Checkpoint[] = [];
  const sourceDefaults: SeedDefault[] = [];
  const evidence: Evidence[] = [];
  const frozenSnapshots: SessionSnapshot[] = [];
  const successfulSources: Source[] = [];
  const warnings: string[] = [];
  let incomplete = false;
  const warnedUnknown = new Set<string>();

  const warnUnknown = (source: Source, item: Evidence) => {
    const key = `${source.sessionId}\u0000${item.branchId}\u0000${selectionKey(item)}`;
    if (warnedUnknown.has(key)) return;
    warnedUnknown.add(key);
    warnings.push(
      `${source.file}: selection timestamp unknown for ${item.entryId}${
        item.editId ? ` (edit ${item.editId})` : ''
      }`,
    );
  };

  const snapshotsBySource = new Map<string, SessionSnapshot>();
  const treesByPath = new Map<string, SessionTree>();
  for (const snapshot of snapshots) {
    const path = resolve(snapshot.source.file);
    const key = sourceKey(snapshot.source);
    budget.reserveSource(path);
    if (snapshotsBySource.has(key)) continue;
    budget.retain(snapshot.tree);
    snapshotsBySource.set(key, snapshot);
    if (!treesByPath.has(path)) treesByPath.set(path, snapshot.tree);
  }
  const sourceKeys = new Set<string>();
  for (const source of sources) {
    const path = resolve(source.file);
    const key = sourceKey(source);
    if (sourceKeys.has(key)) continue;
    sourceKeys.add(key);
    budget.reserveSource(path);
    try {
      const sourceSince =
        source.seedSince === undefined || source.seedSince === null
          ? null
          : absoluteTimestamp(source.seedSince);
      const normalizedSource = { ...source, seedSince: sourceSince };
      const snapshot = snapshotsBySource.get(key);
      const tree =
        snapshot?.tree ?? treesByPath.get(path) ?? readSession(source.file, budget.limits);
      budget.retain(tree);
      if (!treesByPath.has(path)) treesByPath.set(path, tree);
      if (tree.sessionId !== source.sessionId) throw Error('Session header ID changed');
      budget.review(tree);
      const boundaries = new Map<string, Checkpoint>();
      for (const tip of reviewed) {
        if (tip.sessionId !== source.sessionId) continue;
        const checkpoint: Checkpoint = {
          ...tip,
          since: 'since' in tip ? tip.since : null,
        };
        checkpoint.since = checkpoint.since === null ? null : absoluteTimestamp(checkpoint.since);
        if (!tree.entries.has(checkpoint.entryId))
          throw Error(`Review boundary unavailable: ${checkpoint.entryId}`);
        boundaries.set(checkpoint.entryId, checkpoint);
      }

      const sourceEvidence: Evidence[] = [];
      const sourceTips: Tip[] = [];
      const sourceCheckpoints: Checkpoint[] = [];
      for (const tip of tree.tips) {
        let ancestorId: string | null = tip.entryId;
        let ancestor: Checkpoint | undefined;
        while (ancestorId !== null) {
          ancestor = boundaries.get(ancestorId);
          if (ancestor) break;
          const entry = tree.entries.get(ancestorId);
          if (!entry) throw Error(`Review boundary unavailable: ${ancestorId}`);
          ancestorId = entry.parentId;
        }

        const effectiveSince = checkpointSince(ancestor, normalizedSource, requestedSince);
        const previous = new Map<string, string | null>();
        if (ancestor) {
          for (const item of branchEvidence(tree, { ...tip, entryId: ancestor.entryId })) {
            if (timestampMillis(item.timestamp) === null) warnUnknown(source, item);
            if (isEligible(item, ancestor.since)) previous.set(selectionKey(item), item.editId);
          }
        }

        const branch = branchEvidence(tree, tip, ancestor?.entryId ?? null);
        for (const item of branch) {
          if (timestampMillis(item.timestamp) === null) warnUnknown(source, item);
          if (!isEligible(item, effectiveSince)) continue;
          if (previous.get(selectionKey(item)) === item.editId) continue;
          sourceEvidence.push(item);
        }

        const needsCheckpoint =
          ancestor === undefined ||
          ancestor.entryId !== tip.entryId ||
          (ancestor.since !== null && effectiveSince !== ancestor.since);
        if (needsCheckpoint) {
          sourceTips.push(tip);
          sourceCheckpoints.push({ ...tip, since: effectiveSince });
        }
      }

      if (requestedSince !== null) {
        const nextDefault = earlierFinite(sourceSince, requestedSince);
        if (nextDefault !== sourceSince && nextDefault !== null)
          sourceDefaults.push({ sessionId: source.sessionId, since: nextDefault });
      }
      tips.push(...sourceTips);
      checkpoints.push(...sourceCheckpoints);
      evidence.push(...sourceEvidence);
      frozenSnapshots.push({ source: normalizedSource, tree });
      successfulSources.push(normalizedSource);
    } catch (error) {
      if (error instanceof ReviewLimitError) throw error;
      incomplete = true;
      warnings.push(`${source.file}: ${String(error)}`);
    }
  }

  return {
    tips,
    checkpoints,
    sourceDefaults,
    evidence,
    snapshots: frozenSnapshots,
    successfulSources,
    warnings,
    incomplete,
    coverageChanged: checkpoints.length > 0 || sourceDefaults.length > 0,
  };
}
