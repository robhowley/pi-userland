import { randomUUID } from 'node:crypto';
import type { FinishPlan } from './checkpoints.js';
import { prepareReview, type Checkpoint, type Source } from './evidence.js';
import { validateSubmission, type ProposalSubmission } from './proposals.js';
import {
  boundedEvidencePage,
  frozenContext,
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
    return frozenContext(this.review, this.id, args);
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
