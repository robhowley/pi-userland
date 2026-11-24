import { randomUUID } from 'node:crypto';
import type { FinishPlan } from './checkpoints.js';
import type { PreparedReview } from './evidence.js';
import { validateSubmission, type ProposalSubmission } from './proposals.js';
import type { Finding, FindingRecord } from './review-findings.js';
import { ReviewPlan, ownReview, type PlannedRange } from './review-plan.js';
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
  private readonly findings = new Map<string, FindingRecord | null>();
  // Membership, exact branch histories and dispositions share the same record objects.
  readonly records: (FindingRecord & { submission?: ProposalSubmission | null })[] = [];
  private reconciliationClosed = false;
  private readonly review: PreparedReview;

  constructor(
    review: PreparedReview,
    private readonly assertActive: () => void,
  ) {
    // Publication and extraction must observe the same original claims, not caller mutations.
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
    if (this.reconciliationClosed) throw new Error('Capture reconciliation is closed');
    if (
      new Set(findingIds).size !== findingIds.length ||
      findingIds.some((id) => this.findings.has(id))
    )
      throw new Error('Repeated capture finding');
    this.extractionPlan.acceptExtraction(range);
    findingIds.forEach((id) => this.findings.set(id, null));
  }

  reconcileFinding(id: string, recordId: string, finding?: Finding): FindingRecord {
    this.assertActive();
    let record = this.records.find((item) => item.id === recordId);
    if (
      this.reconciliationClosed ||
      this.findings.get(id) !== null ||
      record?.submission !== undefined ||
      (finding && finding.id !== id)
    )
      throw new Error('Unknown finding or already reconciled/disposed capture record');
    if (!record) {
      record = { id: recordId, label: finding?.label ?? recordId, findings: [], ambiguous: false };
      this.records.push(record);
    }
    if (finding) record.findings.push(finding);
    this.findings.set(id, record);
    return record;
  }

  mergeRecords(target: string, absorbed: readonly string[]): void {
    this.assertActive();
    const ids = new Set([target, ...absorbed]);
    if (
      this.reconciliationClosed ||
      ids.size !== absorbed.length + 1 ||
      [...ids].some((id) => {
        const record = this.records.find((item) => item.id === id);
        return !record || record.submission !== undefined;
      })
    )
      throw new Error('Unknown or disposed capture merge record');
    const record = this.records.find((item) => item.id === target)!;
    for (const id of absorbed) {
      const index = this.records.findIndex((item) => item.id === id);
      record.findings.push(...this.records[index]!.findings);
      this.records.splice(index, 1);
    }
    for (const [finding, owner] of this.findings)
      if (owner !== null && ids.has(owner.id)) this.findings.set(finding, record);
  }

  disposeRecord(id: string, submission: ProposalSubmission | null): void {
    this.assertActive();
    const record = this.records.find((item) => item.id === id);
    if (this.reconciliationClosed || !record || record.submission !== undefined)
      throw new Error('Unknown or already disposed capture record');
    record.submission = structuredClone(submission);
  }

  finishReconciliation(): ProposalSubmission[] {
    this.assertActive();
    this.sharedPlan().assertComplete();
    if (
      [...this.findings.values()].some((id) => id === null) ||
      this.records.some((record) => record.submission === undefined)
    )
      throw new Error('Finish reconciliation and disposition of every capture finding');
    this.reconciliationClosed = true;
    return structuredClone(this.reconciledSubmissions());
  }

  private reconciledSubmissions(): ProposalSubmission[] {
    return this.records
      .map((record) => record.submission)
      .filter((value): value is ProposalSubmission => value !== null && value !== undefined);
  }

  extractionContext(args: {
    batch: string;
    selected: Selected;
    before?: number;
    skip?: number;
    offset?: number;
    textUnits?: number;
    tokenLimit?: number;
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
      if (
        !this.reconciliationClosed ||
        JSON.stringify(submissions) !== JSON.stringify(this.reconciledSubmissions())
      )
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
