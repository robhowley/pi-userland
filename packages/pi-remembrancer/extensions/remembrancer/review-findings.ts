import type { PlannedRange } from './review-plan.js';
import { safePrefixLength } from './review-pages.js';
import type { EvidenceReference, ProposalDraft, ProposalSubmission } from './proposals.js';
import { validateDraft } from './proposals.js';
import { estimateReviewerTokens, ReviewerBudgetError } from './reviewer-budget.js';

export const findingKinds = [
  'accepted',
  'correction',
  'refusal',
  'progress',
  'completion',
  'reference',
] as const;
export type FindingKind = (typeof findingKinds)[number];
export type Finding = {
  id: string;
  label: string;
  kind: FindingKind;
  range: PlannedRange;
  start: number;
  end: number;
};
export type FindingRecord = { id: string; label: string; findings: Finding[]; ambiguous: boolean };
export type FoldedFinding = {
  summary: string;
  status: 'active' | 'completed' | 'refused' | 'uncertain';
  draft: ProposalDraft | null;
};

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid capture step object');
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid capture step text');
  return value;
}
export function folded(value: unknown): FoldedFinding {
  const data = object(value);
  text(data['summary']);
  if (!['active', 'completed', 'refused', 'uncertain'].includes(String(data['status'])))
    throw new Error('Invalid capture finding status');
  if (data['draft'] !== null) validateDraft(data['draft'] as ProposalDraft);
  return data as FoldedFinding;
}
export function exactFinding(finding: Finding) {
  return {
    id: finding.id,
    label: finding.label,
    kind: finding.kind,
    range: finding.range,
    start: finding.start,
    end: finding.end,
  };
}
export function references(findings: readonly Finding[]): EvidenceReference[] {
  return findings.flatMap((finding) =>
    finding.range.occurrences.map((occurrence) => ({
      sessionId: occurrence.sessionId,
      branchId: occurrence.branchId,
      entryId: occurrence.entryId,
      editId: occurrence.editId,
      offset: finding.start,
      quote: finding.range.text.slice(
        finding.start - finding.range.offset,
        finding.end - finding.range.offset,
      ),
    })),
  );
}

/** Structured field pages, never JSON fragments the model must concatenate. Originals stay in host memory. */
export function* detailPages(
  value: unknown,
  limit: number,
  path: (string | number)[] = [],
): Generator<object> {
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) yield { path, value };
    for (const [key, child] of entries) yield* detailPages(child, limit, [...path, key]);
    return;
  }
  if (typeof value !== 'string') {
    yield { path, value };
    return;
  }
  let offset = 0;
  do {
    let length = safePrefixLength(value, offset, Math.max(2, Math.floor(limit / 8)));
    while (
      estimateReviewerTokens({ path, offset, text: value.slice(offset, offset + length) }) > limit
    ) {
      length = safePrefixLength(value, offset, Math.floor(length / 2));
      if (!length) throw new ReviewerBudgetError('Capture detail metadata cannot fit');
    }
    yield {
      path,
      offset,
      text: value.slice(offset, offset + length),
      end: offset + length === value.length,
    };
    offset += length;
  } while (offset < value.length);
}

export function validateMaterialization(
  value: unknown,
  record: FindingRecord,
  state: FoldedFinding,
): Omit<ProposalSubmission, 'references'> | null {
  const result = object(value);
  text(result['reason']);
  if (result['submission'] === null) {
    if (record.ambiguous || state.status === 'uncertain')
      throw new Error('Ambiguous capture requires a question');
    return null;
  }
  const submission = object(result['submission']) as Omit<ProposalSubmission, 'references'>;
  if (
    Object.keys(submission).some(
      (key) => !['change', 'expected', 'question', 'explanation'].includes(key),
    )
  )
    throw new Error('Materialization cannot select references or proposal identity');
  validateDraft({
    change: submission.change,
    expected: submission.expected,
    question: submission.question,
  });
  text(submission.explanation);
  if (
    (record.ambiguous ||
      state.status === 'uncertain' ||
      state.status === 'refused' ||
      (state.status === 'completed' && submission.change.operation === 'add')) &&
    !submission.question
  )
    throw new Error('Unsupported or ambiguous capture outcome requires a question');
  return submission;
}
