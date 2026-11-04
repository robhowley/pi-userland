import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type Tip = { file: string; sessionId: string; entryId: string };
export type Evidence = Tip & {
  role: string;
  text: string;
  cwd: string;
  timestamp: string;
  branchId: string;
  reviewedThrough: string | null;
  editId: string | null;
};
export type Source = Pick<Tip, 'sessionId' | 'file'>;
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
      timestamp: e.timestamp ?? '',
      branchId: tip.entryId,
      reviewedThrough,
      editId: edit?.id ?? null,
    });
  }
  return evidence.reverse();
}

/** Read each enrolled source once, then freeze branch evidence and finish boundaries. */
export function prepareReview(sources: readonly Source[], reviewed: readonly Tip[]) {
  const tips: Tip[] = [];
  const evidence: Evidence[] = [];
  const warnings: string[] = [];
  for (const source of sources) {
    try {
      const tree = readSession(source.file);
      if (tree.sessionId !== source.sessionId) throw Error('Session header ID changed');
      const boundaries = new Set(
        reviewed.filter((tip) => tip.sessionId === source.sessionId).map((tip) => tip.entryId),
      );
      for (const id of boundaries) {
        if (!tree.entries.has(id)) throw Error(`Review boundary unavailable: ${id}`);
      }
      for (const tip of tree.tips) {
        if (boundaries.has(tip.entryId)) continue;
        let ancestor: string | null = tip.entryId;
        while (ancestor !== null && !boundaries.has(ancestor))
          ancestor = tree.entries.get(ancestor)!.parentId;
        const previous = new Map(
          ancestor === null
            ? []
            : branchEvidence(tree, { ...tip, entryId: ancestor }).map((item) => [
                item.entryId,
                item.editId,
              ]),
        );
        // Separate leaves are alternatives. Repeat their shared context rather than
        // flattening branches together or discovering ancestry in other files.
        evidence.push(
          ...branchEvidence(tree, tip, ancestor).filter(
            (item) => !previous.has(item.entryId) || previous.get(item.entryId) !== item.editId,
          ),
        );
        tips.push(tip);
      }
    } catch (error) {
      warnings.push(`${source.file}: ${String(error)}`);
    }
  }
  return { tips, evidence, warnings };
}
