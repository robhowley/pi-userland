import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { FinishPlan } from './checkpoints.js';
import { branchEvidence, prepareReview, type Checkpoint, type Source } from './evidence.js';
import { validateSubmission, type ProposalSubmission } from './proposals.js';
import {
  boundedEvidencePage,
  contextPage,
  groupEvidencePage,
  type PageCursor,
  type Selected,
} from './review-pages.js';

// Only host-selected source preparation creates coverage. Model reads cannot supply
// a plan, move the evidence cursor, or promote supporting context into evidence.
export class CaptureReview {
  readonly id = randomUUID();
  private readonly review;
  private cursor: PageCursor = { index: 0, offset: 0 };

  constructor(
    source: Source,
    reviewed: readonly Checkpoint[],
    private readonly assertActive: () => void,
  ) {
    this.review = prepareReview([source], [...reviewed]);
  }

  get hasEvidence(): boolean {
    return this.review.evidence.length > 0;
  }

  get incomplete(): boolean {
    return this.review.incomplete;
  }

  get warnings() {
    return structuredClone(this.review.warnings);
  }

  page(envelope: Record<string, unknown> = {}) {
    this.assertActive();
    const result = boundedEvidencePage(this.review.evidence, this.cursor, (entries, cursor) => ({
      ...envelope,
      batch: this.id,
      groups: groupEvidencePage(entries),
      hasMore: cursor.index < this.review.evidence.length,
    }));
    this.cursor = result.cursor;
    return result.data;
  }

  context(args: { batch: string; selected?: Selected; before?: number; offset?: number }): object {
    this.assertActive();
    if (args.batch !== this.id) throw new Error('No matching open capture in this Pi session.');
    const selected = args.selected;
    if (!selected) throw new Error('Context requires a selected evidence item.');
    const selectedEvidence = this.review.evidence.find(
      (item) =>
        item.sessionId === selected.sessionId &&
        item.branchId === selected.branchId &&
        item.entryId === selected.entryId &&
        item.editId === selected.editId,
    );
    if (!selectedEvidence) throw new Error('Selected evidence is not in this review batch.');
    const snapshot = this.review.snapshots.find(
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
      this.id,
      selected,
      branch.slice(Math.max(0, selectedIndex - before), selectedIndex),
      offset,
    );
  }

  completion(submissions: readonly ProposalSubmission[]) {
    this.assertActive();
    if (this.incomplete) throw new Error('Cannot finish incomplete capture scope');
    if (!this.hasEvidence) throw new Error('Cannot finish capture without eligible evidence');
    if (this.cursor.index !== this.review.evidence.length || this.cursor.offset !== 0)
      throw new Error('Read all evidence pages before finishing');
    if (!Array.isArray(submissions))
      throw new Error('Capture requires proposals array (empty is valid)');
    const sources = submissions.map((submission) =>
      validateSubmission(submission, this.review.evidence),
    );
    const plan: FinishPlan = {
      sources: this.review.successfulSources,
      sourceDefaults: this.review.sourceDefaults,
      checkpoints: this.review.checkpoints,
    };
    return { plan: structuredClone(plan), sources };
  }
}
