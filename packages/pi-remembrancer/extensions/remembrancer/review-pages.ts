import { resolve } from 'node:path';
import { branchEvidence, type Evidence, type PreparedReview } from './evidence.js';

export type Selected = {
  sessionId: string;
  branchId: string;
  entryId: string;
  editId: string | null;
};

export const REVIEW_RESPONSE_MAX_BYTES = 50 * 1024;
const PAGE_MAX_TEXT_UNITS = 48_000;
const PAGE_MAX_ENTRIES = 200;

export type EvidencePageEntry = Evidence & { offset: number; continues: boolean };
type EvidencePageItem = Pick<Evidence, 'entryId' | 'role' | 'text' | 'timestamp' | 'editId'> & {
  offset: number;
  continues: boolean;
};
type EvidenceGroup = Pick<
  Evidence,
  'file' | 'sessionId' | 'cwd' | 'branchId' | 'reviewedThrough'
> & {
  entries: EvidencePageItem[];
};
export type PageCursor = { index: number; offset: number };

export function serializedResponse(data: object): string {
  const text = JSON.stringify(data);
  if (text === undefined) throw new Error('Remembrancer response is not JSON serializable.');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > REVIEW_RESPONSE_MAX_BYTES)
    throw new Error(
      `Remembrancer response is ${bytes} UTF-8 bytes, over the ${REVIEW_RESPONSE_MAX_BYTES}-byte limit; metadata or envelope cannot fit.`,
    );
  return text;
}

function fitsResponse(data: object): boolean {
  const text = JSON.stringify(data);
  if (text === undefined) throw new Error('Remembrancer response is not JSON serializable.');
  return Buffer.byteLength(text, 'utf8') <= REVIEW_RESPONSE_MAX_BYTES;
}

function sameGroup(
  a: Pick<Evidence, 'file' | 'sessionId' | 'cwd' | 'branchId' | 'reviewedThrough'>,
  b: Pick<Evidence, 'file' | 'sessionId' | 'cwd' | 'branchId' | 'reviewedThrough'>,
): boolean {
  return (
    a.file === b.file &&
    a.sessionId === b.sessionId &&
    a.cwd === b.cwd &&
    a.branchId === b.branchId &&
    a.reviewedThrough === b.reviewedThrough
  );
}

export function groupEvidencePage(entries: readonly EvidencePageEntry[]): EvidenceGroup[] {
  const groups: EvidenceGroup[] = [];
  for (const entry of entries) {
    let group = groups.at(-1);
    if (!group || !sameGroup(group, entry)) {
      group = {
        file: entry.file,
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        branchId: entry.branchId,
        reviewedThrough: entry.reviewedThrough,
        entries: [],
      };
      groups.push(group);
    }
    group.entries.push({
      entryId: entry.entryId,
      role: entry.role,
      text: entry.text,
      timestamp: entry.timestamp,
      editId: entry.editId,
      offset: entry.offset,
      continues: entry.continues,
    });
  }
  return groups;
}

function splitsSurrogatePair(text: string, boundary: number): boolean {
  if (boundary <= 0 || boundary >= text.length) return false;
  const before = text.charCodeAt(boundary - 1);
  const after = text.charCodeAt(boundary);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function safePrefixLength(text: string, start: number, maxUnits: number): number {
  let length = Math.min(maxUnits, text.length - start);
  if (length > 0 && splitsSurrogatePair(text, start + length)) length--;
  return length;
}

export function boundedEvidencePage(
  evidence: readonly Evidence[],
  initial: PageCursor,
  buildResponse: (entries: EvidencePageEntry[], cursor: PageCursor) => Record<string, unknown>,
): { data: Record<string, unknown>; cursor: PageCursor } {
  let { index, offset } = initial;
  const entries: EvidencePageEntry[] = [];
  let remainingText = PAGE_MAX_TEXT_UNITS;

  const candidateFits = (entry: EvidencePageEntry, cursor: PageCursor) =>
    fitsResponse(buildResponse([...entries, entry], cursor));
  const append = (item: Evidence, length: number) => {
    const start = offset;
    const continues = start + length < item.text.length;
    const entry: EvidencePageEntry = {
      ...item,
      text: item.text.slice(start, start + length),
      offset: start,
      continues,
    };
    const cursor = continues ? { index, offset: start + length } : { index: index + 1, offset: 0 };
    if (!candidateFits(entry, cursor)) return false;
    entries.push(entry);
    remainingText -= length;
    ({ index, offset } = cursor);
    return true;
  };

  while (entries.length < PAGE_MAX_ENTRIES && remainingText > 0 && index < evidence.length) {
    const item = evidence[index];
    if (!item) break;
    const wanted = safePrefixLength(item.text, offset, remainingText);

    if (item.text.length === offset) {
      if (!append(item, 0)) {
        if (entries.length === 0)
          throw new Error(
            `Remembrancer response cannot fit a complete evidence entry within the ${REVIEW_RESPONSE_MAX_BYTES}-byte UTF-8 limit; metadata or envelope cannot fit.`,
          );
        break;
      }
      continue;
    }
    if (wanted === 0) break;

    if (append(item, wanted)) {
      if (entries.at(-1)?.continues || remainingText === 0) break;
      continue;
    }

    let low = 0;
    let high = wanted - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const length = safePrefixLength(item.text, offset, middle);
      if (length === 0) {
        low = middle + 1;
        continue;
      }
      const start = offset;
      const entry: EvidencePageEntry = {
        ...item,
        text: item.text.slice(start, start + length),
        offset: start,
        continues: true,
      };
      if (candidateFits(entry, { index, offset: start + length })) {
        low = middle;
        continue;
      }
      high = middle - 1;
    }
    const length = safePrefixLength(item.text, offset, low);
    if (length > 0 && append(item, length)) break;
    if (entries.length === 0)
      throw new Error(
        `Remembrancer response cannot fit a complete evidence entry within the ${REVIEW_RESPONSE_MAX_BYTES}-byte UTF-8 limit; metadata or envelope cannot fit.`,
      );
    break;
  }

  const cursor = { index, offset };
  const data = buildResponse(entries, cursor);
  serializedResponse(data);
  return { data, cursor };
}

export function frozenContext(
  review: Pick<PreparedReview, 'evidence' | 'snapshots'>,
  batch: string,
  args: { selected?: Selected; before?: number; offset?: number },
) {
  const selected = args.selected;
  if (!selected) throw new Error('Context requires a selected evidence item.');
  const selectedEvidence = review.evidence.find(
    (item) =>
      item.sessionId === selected.sessionId &&
      item.branchId === selected.branchId &&
      item.entryId === selected.entryId &&
      item.editId === selected.editId,
  );
  if (!selectedEvidence) throw new Error('Selected evidence is not in this review batch.');
  const snapshot = review.snapshots.find(
    (candidate) =>
      candidate.source.sessionId === selected.sessionId &&
      resolve(candidate.source.file) === resolve(selectedEvidence.file),
  );
  if (!snapshot) throw new Error('Selected evidence snapshot is unavailable.');
  const branch = branchEvidence(
    snapshot.tree,
    { file: snapshot.source.file, sessionId: selected.sessionId, entryId: selected.branchId },
    selectedEvidence.reviewedThrough,
  );
  const selectedIndex = branch.findIndex(
    (item) => item.entryId === selected.entryId && item.editId === selected.editId,
  );
  if (selectedIndex < 0) throw new Error('Selected evidence is not in the frozen branch.');
  const before = args.before ?? 1;
  const offset = args.offset ?? 0;
  if (!Number.isInteger(before) || before < 1 || before > 40)
    throw new Error('Context before must be an integer from 1 to 40.');
  if (!Number.isInteger(offset) || offset < 0)
    throw new Error('Context offset must be a nonnegative integer.');
  return contextPage(
    batch,
    selected,
    branch.slice(Math.max(0, selectedIndex - before), selectedIndex),
    offset,
  );
}

export function contextPage(batch: string, selected: Selected, items: Evidence[], offset: number) {
  const total = items.reduce((length, item) => length + item.text.length, 0);
  if (offset > total) throw new Error('Context offset is beyond the requested range');

  let index = 0;
  let localOffset = 0;
  let position = 0;
  while (index < items.length) {
    const item = items[index]!;
    if (item.text.length === 0) {
      if (offset === position) break;
      index++;
      continue;
    }
    const end = position + item.text.length;
    if (offset < end) {
      localOffset = offset - position;
      if (splitsSurrogatePair(item.text, localOffset))
        throw new Error('Context offset splits a surrogate pair; use a returned nextOffset.');
      break;
    }
    position = end;
    index++;
  }

  const result = boundedEvidencePage(items, { index, offset: localOffset }, (entries, cursor) => {
    const nextOffset =
      items.slice(0, cursor.index).reduce((length, item) => length + item.text.length, 0) +
      cursor.offset;
    return {
      batch,
      selected,
      contextOnly: true,
      groups: groupEvidencePage(entries),
      nextOffset: nextOffset < total ? nextOffset : null,
    };
  });
  return result.data;
}
