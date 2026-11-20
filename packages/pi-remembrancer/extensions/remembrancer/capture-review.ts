import { randomUUID } from 'node:crypto';
import type { FinishPlan } from './checkpoints.js';
import type { PreparedReview } from './evidence.js';
import { validateSubmission, type ProposalSubmission } from './proposals.js';
import { ReviewPlan, type PlannedRange } from './review-plan.js';
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
  private cursor: PageCursor = { index: 0, offset: 0 };
  private extractionPlan?: ReviewPlan;
  private pageRead = false;
  private readonly findings = new Map<string, string | null>();
  private readonly dispositions = new Map<string, ProposalSubmission | null | undefined>();
  private reconciled: ProposalSubmission[] | undefined;

  constructor(
    private readonly review: PreparedReview,
    private readonly assertActive: () => void,
  ) {}

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
    if (this.extractionPlan) throw new Error('Capture is using accepted extraction ranges.');
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

  private sharedPlan(): ReviewPlan {
    this.assertActive();
    if (this.pageRead)
      throw new Error('Cannot switch a capture from evidence pages to extraction.');
    return (this.extractionPlan ??= new ReviewPlan(this.review));
  }

  nextExtraction(maxTextUnits?: number): PlannedRange | null {
    return this.sharedPlan().next(maxTextUnits);
  }

  extractionSurrounding(range: PlannedRange, units: number) {
    return this.sharedPlan().surrounding(range, units);
  }

  // Host calls this only after accepting the result. Reading or context never acknowledges ranges.
  acceptExtraction(range: PlannedRange, findingIds: readonly string[] = []): void {
    this.assertActive();
    if (!this.extractionPlan) throw new Error('Capture extraction has not started.');
    if (this.reconciled) throw new Error('Capture reconciliation is closed');
    if (
      new Set(findingIds).size !== findingIds.length ||
      findingIds.some((id) => this.findings.has(id))
    )
      throw new Error('Repeated capture finding');
    this.extractionPlan.acceptExtraction(range);
    findingIds.forEach((id) => this.findings.set(id, null));
  }

  reconcileFinding(id: string, recordId: string): void {
    this.assertActive();
    if (this.reconciled || this.findings.get(id) !== null)
      throw new Error('Unknown or already reconciled capture finding');
    this.findings.set(id, recordId);
    if (!this.dispositions.has(recordId)) this.dispositions.set(recordId, undefined);
  }

  disposeRecord(id: string, submission: ProposalSubmission | null): void {
    this.assertActive();
    if (this.reconciled || !this.dispositions.has(id) || this.dispositions.get(id) !== undefined)
      throw new Error('Unknown or already disposed capture record');
    this.dispositions.set(id, structuredClone(submission));
  }

  finishReconciliation(): ProposalSubmission[] {
    this.assertActive();
    this.sharedPlan().assertComplete();
    if (
      [...this.findings.values()].some((id) => id === null) ||
      [...this.dispositions.values()].some((value) => value === undefined)
    )
      throw new Error('Finish reconciliation and disposition of every capture finding');
    this.reconciled = [...this.dispositions.values()].filter(
      (value): value is ProposalSubmission => value !== null && value !== undefined,
    );
    return structuredClone(this.reconciled);
  }

  extractionContext(args: {
    batch: string;
    selected: Selected;
    before?: number;
    skip?: number;
    offset?: number;
  }): object {
    this.assertActive();
    if (args.batch !== this.id) throw new Error('No matching open capture in this Pi session.');
    return this.sharedPlan().context(this.id, args.selected, args);
  }

  context(args: { batch: string; selected?: Selected; before?: number; offset?: number }): object {
    this.assertActive();
    if (args.batch !== this.id) throw new Error('No matching open capture in this Pi session.');
    return frozenContext(this.review, this.id, args);
  }

  completion(submissions: readonly ProposalSubmission[]) {
    this.assertActive();
    if (this.incomplete) throw new Error('Cannot finish incomplete capture scope');
    if (!Array.isArray(submissions))
      throw new Error('Capture requires proposals array (empty is valid)');
    if (!this.hasEvidence && submissions.length)
      throw new Error('No evidence for capture proposals');
    if (this.extractionPlan) {
      this.extractionPlan.assertComplete();
      if (!this.reconciled || JSON.stringify(submissions) !== JSON.stringify(this.reconciled))
        throw new Error('Finish capture reconciliation and submit exactly its dispositions');
    } else if (this.cursor.index !== this.review.evidence.length || this.cursor.offset !== 0)
      throw new Error('Read all evidence pages before finishing');
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
