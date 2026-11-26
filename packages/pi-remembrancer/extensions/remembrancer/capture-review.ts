import { randomUUID } from 'node:crypto';
import type { FinishPlan } from './checkpoints.js';
import type { PreparedReview } from './evidence.js';
import {
  validateReferences,
  validateSubmission,
  type EvidenceReference,
  type ProposalSubmission,
} from './proposals.js';
import { ownReview } from './review-plan.js';
import {
  boundedEvidencePage,
  frozenContext,
  groupEvidencePage,
  serializedResponse,
  type PageCursor,
  type Selected,
} from './review-pages.js';

export type PreparedCapturePage = Readonly<{
  text: string;
  assertReadable(): void;
  accept(): void;
}>;

// Only accepted host-issued pages create coverage. Supporting context never does.
export class CaptureReview {
  readonly id = randomUUID();
  private cursor: PageCursor = { index: 0, offset: 0 };
  private pageRead = false;
  private readonly review: PreparedReview;

  constructor(
    review: PreparedReview,
    private readonly assertActive: () => void,
  ) {
    // Publication and delivery must observe the same original claims, not caller mutations.
    this.review = ownReview(review);
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

  /** Prepare the complete frozen evidence without acknowledging any delivery. */
  *preparePages(): Generator<PreparedCapturePage> {
    let cursor: PageCursor = { index: 0, offset: 0 };
    do {
      this.assertActive();
      const start = cursor;
      const result = boundedEvidencePage(this.review.evidence, start, (entries, next) => ({
        batch: this.id,
        groups: groupEvidencePage(entries),
        hasMore: next.index < this.review.evidence.length,
      }));
      const end = result.cursor;
      const isNext = () => start.index === this.cursor.index && start.offset === this.cursor.offset;
      const assertReadable = () => {
        this.assertActive();
        const prior =
          end.index < this.cursor.index ||
          (end.index === this.cursor.index && end.offset <= this.cursor.offset);
        if (!isNext() && !prior) throw new Error('Read the next evidence page in order.');
      };
      yield Object.freeze({
        text: serializedResponse(result.data),
        assertReadable,
        // The runner calls this only after accepting the entire text and its budget.
        accept: () => {
          assertReadable();
          if (isNext()) this.cursor = end;
          this.pageRead = true;
        },
      });
      cursor = end;
    } while (cursor.index < this.review.evidence.length);
  }

  assertEvidenceDelivered(): void {
    this.assertActive();
    if (
      !this.pageRead ||
      this.cursor.index !== this.review.evidence.length ||
      this.cursor.offset !== 0
    )
      throw new Error('Read all evidence pages before finishing');
  }

  // Direct host readers accept a complete page synchronously.
  page(envelope: Record<string, unknown> = {}) {
    this.assertActive();
    const result = boundedEvidencePage(this.review.evidence, this.cursor, (entries, cursor) => ({
      ...envelope,
      batch: this.id,
      groups: groupEvidencePage(entries),
      hasMore: cursor.index < this.review.evidence.length,
    }));
    this.cursor = result.cursor;
    this.pageRead = true;
    return result.data;
  }

  context(args: {
    batch: string;
    selected?: Selected;
    before?: number;
    skip?: number;
    offset?: number;
  }): object {
    this.assertActive();
    if (args.batch !== this.id) throw new Error('No matching open capture in this Pi session.');
    return frozenContext(this.review, this.id, args);
  }

  validateReferences(references: readonly EvidenceReference[]) {
    this.assertActive();
    return validateReferences(references, this.review.evidence);
  }

  completion(submissions: readonly ProposalSubmission[]) {
    this.assertActive();
    if (this.incomplete) throw new Error('Cannot finish incomplete capture scope');
    if (!Array.isArray(submissions))
      throw new Error('Capture requires proposals array (empty is valid)');
    if (!this.hasEvidence && submissions.length)
      throw new Error('No evidence for capture proposals');
    // Empty bootstrap jobs never start a reviewer. Actual reviews enforce even empty
    // artifact delivery through CaptureArtifacts.assertDelivered() before staging.
    if (this.hasEvidence) this.assertEvidenceDelivered();
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
