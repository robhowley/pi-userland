import { readFileSync } from 'node:fs';
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

export function readSession(file: string) {
  const raw = readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  const header = JSON.parse(lines.shift() || '{}');
  if (header?.type !== 'session' || typeof header.id !== 'string' || header.id.trim() === '')
    throw Error(`Invalid session header in ${file}`);
  const entries = new Map<string, Entry>();
  const leaves = new Set<string>();
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let e: Entry;
    try {
      e = JSON.parse(line) as Entry;
    } catch (err) {
      throw Error(`Invalid JSON at ${file}:${index + 2}`, { cause: err });
    }
    if (
      !e ||
      typeof e.id !== 'string' ||
      !e.id ||
      typeof e.type !== 'string' ||
      entries.has(e.id) ||
      !(e.parentId === null || entries.has(e.parentId))
    )
      throw Error(`Invalid session tree at ${file}:${index + 2}`);
    entries.set(e.id, e);
    if (e.parentId) leaves.delete(e.parentId);
    leaves.add(e.id);
  }
  const tips: Tip[] = [...leaves].map((entryId) => ({
    file: resolve(file),
    sessionId: header.id,
    entryId,
  }));
  return {
    sessionId: header.id as string,
    cwd: typeof header.cwd === 'string' && header.cwd.trim() ? String(header.cwd) : '(unknown)',
    entries,
    tips,
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
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter((b) => b?.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text)
              .join('\n')
          : '';
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

  for (const source of sources) {
    try {
      const sourceSince =
        source.seedSince === undefined || source.seedSince === null
          ? null
          : absoluteTimestamp(source.seedSince);
      const normalizedSource = { ...source, seedSince: sourceSince };
      const snapshot = snapshots.find(
        (candidate) =>
          candidate.source.sessionId === source.sessionId &&
          resolve(candidate.source.file) === resolve(source.file),
      );
      const tree = snapshot?.tree ?? readSession(source.file);
      if (tree.sessionId !== source.sessionId) throw Error('Session header ID changed');
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
