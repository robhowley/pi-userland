import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type Tip = { file: string; sessionId: string; entryId: string };
export type Evidence = Tip & {
  role: string;
  text: string;
  cwd: string;
  timestamp: string;
  key: string;
};
type Source = Pick<Tip, 'sessionId' | 'file'>;
type Entry = {
  id: string;
  parentId: string | null;
  type: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
  targetId?: string;
  replacement?: { content?: unknown } | null;
};

export function readSession(file: string) {
  const raw = readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  const header = JSON.parse(lines.shift() || '{}');
  if (header?.type !== 'session' || typeof header.id !== 'string')
    throw Error(`Invalid session header in ${file}`);
  const entries = new Map<string, Entry>();
  const leaves = new Set<string>();
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let e: Entry;
    try {
      e = JSON.parse(line);
    } catch (err) {
      if (index === lines.length - 1 && !raw.endsWith('\n')) break;
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
    parentSession:
      typeof header.parentSession === 'string' ? (header.parentSession as string) : undefined,
    entries,
    tips,
  };
}

export type SessionTree = ReturnType<typeof readSession>;

/** Include only visible user and assistant text on the immutable path to tip. */
export function branchEvidence(
  tree: SessionTree,
  tip: Tip,
  enrolled: ReadonlyMap<string, SessionTree> = new Map(),
  walked = new Set<string>(),
): Evidence[] {
  if (tip.sessionId !== tree.sessionId || !tree.entries.has(tip.entryId))
    throw Error('Unknown review boundary');
  const evidence: Evidence[] = [];
  const edits = new Map<string, Entry>();
  let id: string | null = tip.entryId;
  while (id !== null) {
    // Sibling paths share a prefix. Reuse its coverage only when no branch-local
    // edit still changes how an earlier entry will be projected.
    if (!edits.size) {
      if (walked.has(id)) break;
      walked.add(id);
    }
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
    let origin = tree;
    const visited = new Set([tree.sessionId]);
    while (origin.parentSession) {
      const parent = enrolled.get(resolve(origin.parentSession));
      if (!parent || visited.has(parent.sessionId)) break;
      const inherited = parent.entries.get(e.id);
      if (
        !inherited ||
        inherited.timestamp !== e.timestamp ||
        JSON.stringify(inherited.message) !== JSON.stringify(e.message)
      )
        break;
      visited.add(parent.sessionId);
      origin = parent;
    }
    evidence.push({
      ...tip,
      entryId: e.id,
      role,
      text,
      cwd: tree.cwd,
      timestamp: e.timestamp ?? '',
      key: JSON.stringify([origin.sessionId, e.id, edit?.id]),
    });
  }
  return evidence.reverse();
}

export function recover(sources: readonly Source[]) {
  const trees = new Map<string, SessionTree>();
  const tips: Tip[] = [];
  const warnings: string[] = [];
  for (const s of sources) {
    try {
      const path = resolve(s.file);
      const tree = readSession(path);
      if (tree.sessionId !== s.sessionId) throw Error('Session header ID changed');
      trees.set(path, tree);
      tips.push(...tree.tips);
    } catch (err) {
      // Pi may enroll a new session before its first durable write.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
        warnings.push(`${s.file}: ${String(err)}`);
    }
  }
  return { trees, tips, warnings };
}

/** Select tip IDs that have at least one selected descendant, walking each ancestor once. */
function superseded(tree: SessionTree, tips: readonly Tip[]) {
  const ancestors = new Set<string>();
  for (const tip of tips) {
    let id = tree.entries.get(tip.entryId)!.parentId;
    while (id !== null && !ancestors.has(id)) {
      ancestors.add(id);
      id = tree.entries.get(id)!.parentId;
    }
  }
  return ancestors;
}

/** Page this result in memory. Its boundaries do not move with a live session. */
export function prepareReview(
  pending: readonly Tip[],
  reviewed: readonly Tip[],
  trees?: ReadonlyMap<string, SessionTree>,
) {
  const warnings: string[] = [];
  const loaded = new Map<string, SessionTree>();
  const enrolled = trees ?? loaded;
  const relevant = new Set(pending.map((t) => resolve(t.file)));
  if (!trees) {
    // With no recovery snapshot, only follow parent links to files already enrolled.
    const allowed = new Map([...reviewed, ...pending].map((t) => [resolve(t.file), t]));
    for (const path of relevant) {
      const source = allowed.get(path);
      if (!source) continue;
      const result = recover([source]);
      warnings.push(...result.warnings);
      const tree = result.trees.get(path);
      if (!tree) continue;
      loaded.set(path, tree);
      if (tree.parentSession) relevant.add(resolve(tree.parentSession));
    }
  } else {
    // Include reviewed siblings/children of a pending fork from the same recovery
    // snapshot. Unrelated archived files cannot contribute shared message keys.
    const neighbors = new Map<string, string[]>();
    for (const [path, tree] of trees) {
      if (!tree.parentSession) continue;
      const parent = resolve(tree.parentSession);
      if (!trees.has(parent)) continue;
      const children = neighbors.get(parent) ?? [];
      children.push(path);
      neighbors.set(parent, children);
    }
    for (const path of relevant) {
      const parent = trees.get(path)?.parentSession;
      if (parent && trees.has(resolve(parent))) relevant.add(resolve(parent));
      for (const child of neighbors.get(path) ?? []) relevant.add(child);
    }
  }

  const groups = new Map<string, { tree: SessionTree; pending: Tip[]; reviewed: Tip[] }>();
  for (const [kind, list] of [
    ['reviewed', reviewed],
    ['pending', pending],
  ] as const) {
    for (const tip of list) {
      const path = resolve(tip.file);
      if (!relevant.has(path)) continue;
      const tree = enrolled.get(path);
      if (!tree || tree.sessionId !== tip.sessionId || !tree.entries.has(tip.entryId)) {
        warnings.push(`${path}#${tip.entryId}: review boundary unavailable`);
        continue;
      }
      if (!groups.has(path)) groups.set(path, { tree, reviewed: [], pending: [] });
      groups.get(path)![kind].push(tip);
    }
  }

  const tips: Tip[] = [];
  const evidence: Evidence[] = [];
  const seen = new Set<string>();
  for (const kind of ['reviewed', 'pending'] as const) {
    for (const group of groups.values()) {
      const records = group[kind];
      if (!records.length) continue;
      if (kind === 'pending') tips.push(...records);
      const boundaries = kind === 'pending' ? [...records, ...group.reviewed] : records;
      const ancestors = superseded(group.tree, boundaries);
      const walked = new Set<string>();
      for (const tip of records) {
        if (ancestors.has(tip.entryId)) continue;
        for (const item of branchEvidence(group.tree, tip, enrolled, walked)) {
          if (kind === 'pending' && !seen.has(item.key)) evidence.push(item);
          seen.add(item.key);
        }
      }
    }
  }
  return { tips, evidence, warnings };
}
