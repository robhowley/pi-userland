import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { retainRange, transcriptPage } from './review-transcript.js';
import type { Evidence, PreparedReview } from './evidence.js';
import {
  contextPage,
  frozenBranch,
  safePrefixLength,
  splitsSurrogatePair,
  type PageCursor,
  type Selected,
} from './review-pages.js';

export type PlannedOccurrence = Readonly<
  Selected &
    Pick<Evidence, 'file' | 'cwd' | 'reviewedThrough'> & {
      offset: number;
      end: number;
      order: number;
    }
>;

/** Offsets are UTF-16 units, with exclusive ends, just like saved quote references. */
export type PlannedRange = Readonly<{
  id: string;
  versionId: string;
  role: string;
  timestamp: string;
  text: string;
  offset: number;
  end: number;
  occurrences: readonly PlannedOccurrence[];
}>;

type Version = {
  id: string;
  evidence: Evidence;
  occurrences: { item: Evidence; order: number }[];
  accepted: number;
};
const versionId = (item: Evidence) => JSON.stringify([item.sessionId, item.entryId, item.editId]);

const ownedReviews = new WeakSet<PreparedReview>();
/** Share one private copy between extraction and publication, never a caller-owned review. */
export function ownReview(review: PreparedReview): PreparedReview {
  if (ownedReviews.has(review)) return review;
  const copy = structuredClone(review);
  ownedReviews.add(copy);
  return copy;
}

/** Attempt-local only. PreparedReview remains the authority for eligibility and ancestry. */
export class ReviewPlan {
  private readonly review: PreparedReview;
  private readonly versions: Version[];
  private readonly byId = new Map<string, Version>();
  private readonly eligible = new Set<string>();
  private cursor: PageCursor = { index: 0, offset: 0 };
  private pending: PlannedRange | null = null;
  private readonly branches = new Map<
    string,
    { branch: Evidence[]; indices: Map<string, number>; context: string }
  >();

  private branchView(selected: Selected) {
    if (
      !this.eligible.has(
        JSON.stringify([selected.sessionId, selected.branchId, selected.entryId, selected.editId]),
      )
    )
      throw new Error('Selected evidence is not in this review batch.');
    const key = JSON.stringify([selected.sessionId, selected.branchId]);
    let view = this.branches.get(key);
    if (!view) {
      const { branch } = frozenBranch(this.review, selected);
      view = {
        branch,
        indices: new Map(
          branch.map((item, index) => [JSON.stringify([item.entryId, item.editId]), index]),
        ),
        // Equal source text is not enough when branch context differs.
        context: createHash('sha256')
          .update(
            JSON.stringify(
              branch.map(({ editId, role, text, timestamp }) => [editId, role, text, timestamp]),
            ),
          )
          .digest('hex'),
      };
      this.branches.set(key, view);
    }
    const selectedIndex = view.indices.get(JSON.stringify([selected.entryId, selected.editId]));
    if (selectedIndex === undefined)
      throw new Error('Selected evidence is not in the frozen branch.');
    return { ...view, selectedIndex };
  }

  constructor(review: PreparedReview) {
    // No discovery or live reads here, including for context. Own the frozen input.
    this.review = ownReview(review);
    const sources = [
      ...review.successfulSources,
      ...review.snapshots.map((snapshot) => snapshot.source),
      ...review.evidence,
      ...review.tips,
      ...review.checkpoints,
    ];
    const first = sources[0];
    if (
      sources.some(
        (source) =>
          source.sessionId !== first?.sessionId || resolve(source.file) !== resolve(first.file),
      ) ||
      review.sourceDefaults.some((source) => source.sessionId !== first?.sessionId)
    )
      throw new Error('A capture review plan requires one frozen session source.');

    for (const [order, item] of this.review.evidence.entries()) {
      this.eligible.add(JSON.stringify([item.sessionId, item.branchId, item.entryId, item.editId]));
      // Entry IDs belong to one frozen tree; editId is the effective edit on that
      // occurrence's ancestry. Equal text, or a different edit, never shares an ID.
      const id = versionId(item);
      let version = this.byId.get(id);
      if (!version) {
        version = { id, evidence: item, occurrences: [], accepted: 0 };
        this.byId.set(id, version);
      }
      if (version.evidence.text !== item.text || version.evidence.role !== item.role)
        throw new Error('Conflicting frozen evidence for one message version.');
      version.occurrences.push({ item, order });
    }
    this.versions = [...this.byId.values()];
  }

  /** Peek only. The host can shrink an unaccepted range to fit a later request. */
  next(maxTextUnits = 48_000): PlannedRange | null {
    if (!Number.isSafeInteger(maxTextUnits) || maxTextUnits < 1)
      throw new Error('Extraction text limit must be a positive safe integer.');
    const version = this.versions[this.cursor.index];
    if (!version) return null;
    const { evidence } = version;
    const offset = this.cursor.offset;
    const length = safePrefixLength(evidence.text, offset, maxTextUnits);
    if (!length && offset < evidence.text.length)
      throw new Error('Extraction text limit cannot fit the next Unicode character.');
    const end = offset + length;
    this.pending = Object.freeze({
      id: JSON.stringify([version.id, offset, end]),
      versionId: version.id,
      role: evidence.role,
      timestamp: evidence.timestamp,
      text: evidence.text.slice(offset, end),
      offset,
      end,
      occurrences: Object.freeze(
        version.occurrences.map(({ item, order }) =>
          Object.freeze({
            sessionId: item.sessionId,
            branchId: item.branchId,
            entryId: item.entryId,
            editId: item.editId,
            file: item.file,
            cwd: item.cwd,
            reviewedThrough: item.reviewedThrough,
            order,
            offset,
            end,
          }),
        ),
      ),
    });
    retainRange(
      this.pending,
      evidence,
      this.pending.occurrences.map((item) => this.branchView(item).context),
    );
    return this.pending;
  }

  /** Host only, after validating and accepting the extraction result, including empty findings. */
  acceptExtraction(range: PlannedRange): void {
    if (range !== this.pending || range === null)
      throw new Error('Extraction must accept the current host-issued range.');
    const version = this.versions[this.cursor.index]!;
    version.accepted = range.end;
    this.cursor =
      range.end === version.evidence.text.length
        ? { index: this.cursor.index + 1, offset: 0 }
        : { index: this.cursor.index, offset: range.end };
    this.pending = null;
  }

  surrounding(range: PlannedRange, units: number) {
    const selected = range.occurrences[0]!;
    const { branch, selectedIndex } = this.branchView(selected);
    const item = branch[selectedIndex]!;
    const preceding =
      range.offset > 0 ? item.text.slice(0, range.offset) : (branch[selectedIndex - 1]?.text ?? '');
    let start = Math.max(0, preceding.length - units);
    if (splitsSurrogatePair(preceding, start)) start++;
    const previous = preceding.slice(start);
    const subsequent =
      range.end < item.text.length
        ? item.text.slice(range.end)
        : (branch[selectedIndex + 1]?.text ?? '');
    const following = subsequent.slice(0, safePrefixLength(subsequent, 0, units));
    return { contextOnly: true, previous, following };
  }

  /** Check every original occurrence, not proposal counts or the old read cursor. */
  assertComplete(): void {
    if (this.review.incomplete) throw new Error('Cannot finish incomplete capture scope');
    for (const item of this.review.evidence) {
      if (this.byId.get(versionId(item))?.accepted !== item.text.length)
        throw new Error('Accept extraction of every original evidence range before finishing');
    }
    if (this.cursor.index !== this.versions.length || this.cursor.offset !== 0)
      throw new Error('Accept extraction of every original evidence range before finishing');
  }

  /** Read older windows with nextSkip, finishing nextOffset continuations first. Never acknowledges evidence. */
  context(
    batch: string,
    selected: Selected,
    args: {
      before?: number;
      skip?: number;
      offset?: number;
      textUnits?: number;
      tokenLimit?: number;
      fits?: (page: unknown) => boolean;
    } = {},
  ) {
    const { branch, selectedIndex } = this.branchView(selected);
    const before = args.before ?? 1;
    const skip = args.skip ?? 0;
    const offset = args.offset ?? 0;
    if (!Number.isInteger(before) || before < 1 || before > 40)
      throw new Error('Context before must be an integer from 1 to 40.');
    if (!Number.isSafeInteger(skip) || skip < 0 || skip > selectedIndex)
      throw new Error('Context skip is outside the frozen preceding entries.');
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error('Context offset must be a nonnegative safe integer.');
    const end = selectedIndex - skip;
    const start = Math.max(0, end - before);
    const page =
      args.textUnits === undefined
        ? contextPage
        : (
            batch: string,
            selected: Selected,
            items: Evidence[],
            offset: number,
            envelope: Record<string, unknown>,
          ) =>
            transcriptPage(
              batch,
              selected,
              items,
              offset,
              args.textUnits!,
              envelope,
              args.tokenLimit,
              args.fits,
            );
    return page(batch, selected, branch.slice(start, end), offset, {
      skip,
      nextSkip: start > 0 ? selectedIndex - start : null,
    });
  }
}
