import type { PlannedOccurrence, PlannedRange } from './review-plan.js';
import { exactQuote } from './review-transcript.js';
import { fitPrefixLength } from './review-pages.js';
import type {
  EvidenceReference,
  ProposalDraft,
  ProposalSubmission,
  TaskSnapshot,
} from './proposals.js';
import { validateDraft, validateProposalIntent } from './proposals.js';
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
  /** One source observation may have a different identity on each branch. */
  occurrence: PlannedOccurrence;
  sourceId: string;
  observationOrder: number;
  start: number;
  end: number;
};
export type FindingRecord = { id: string; label: string; findings: Finding[]; ambiguous: boolean };
// Intent does not need a model-reproduced snapshot. Only the host can bind one.
export type CaptureDraft = Omit<ProposalDraft, 'expected'> & {
  expected?: TaskSnapshot | null;
};
export type FoldedFinding = {
  summary: string;
  status: 'active' | 'completed' | 'refused' | 'uncertain';
  draft: CaptureDraft | null;
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
  const summary = text(data['summary']);
  if (
    typeof data['status'] !== 'string' ||
    !['active', 'completed', 'refused', 'uncertain'].includes(data['status'])
  )
    throw new Error('Invalid capture finding status');
  return {
    summary,
    status: data['status'] as FoldedFinding['status'],
    draft: data['draft'] === null ? null : validateIntent(data['draft']),
  };
}

/** Validate the proposed operation before looking up or substituting any trusted state. */
export function validateIntent(value: unknown): CaptureDraft {
  const draft = object(value);
  if (Object.keys(draft).some((key) => !['change', 'expected', 'question'].includes(key)))
    throw new Error('Invalid capture intent fields');
  const change = object(draft['change']) as CaptureDraft['change'];
  validateProposalIntent({ change, question: draft['question'] as string | null });
  // Ignore a legacy model-supplied snapshot, including any identity/status inside it.
  return { change, question: draft['question'] as string | null };
}
/** Full aliases remain host-side for coverage, ordering and final quote references. */
export function workingRange(range: PlannedRange) {
  return {
    ...range,
    occurrences: range.occurrences.slice(0, 1),
    occurrenceCount: range.occurrences.length,
  };
}
export function exactFinding(finding: Finding) {
  const quote = exactQuote(finding.range, finding.start, finding.end);
  return {
    id: finding.id,
    label: finding.label,
    kind: finding.kind,
    sourceOccurrenceCount: finding.range.occurrences.length,
    range: workingRange({
      ...finding.range,
      text: quote,
      offset: finding.start,
      end: finding.end,
      occurrences: [finding.occurrence],
    }),
    start: finding.start,
    end: finding.end,
  };
}
export function references(findings: readonly Finding[]): EvidenceReference[] {
  return findings.map((finding) => ({
    sessionId: finding.occurrence.sessionId,
    branchId: finding.occurrence.branchId,
    entryId: finding.occurrence.entryId,
    editId: finding.occurrence.editId,
    offset: finding.start,
    quote: exactQuote(finding.range, finding.start, finding.end),
  }));
}

/** Structured field pages, never JSON fragments the model must concatenate. Originals stay in host memory. */
export function* detailPages(
  value: unknown,
  limit: number,
  path: (string | number)[] = [],
  envelope: (page: object, index: number) => unknown = (page) => page,
): Generator<object> {
  let index = 0;
  const fits = (page: object) => estimateReviewerTokens(envelope(page, index)) <= limit;
  function* walk(value: unknown, path: (string | number)[]): Generator<object> {
    if (value !== null && typeof value === 'object' && Object.keys(value).length) {
      for (const [key, child] of Object.entries(value)) yield* walk(child, [...path, key]);
      return;
    }
    if (typeof value !== 'string') {
      const page = { path, value };
      if (!fits(page)) throw new ReviewerBudgetError('Capture detail metadata cannot fit');
      yield page;
      index++;
      return;
    }
    let offset = 0;
    do {
      const build = (length: number) => ({
        path,
        offset,
        text: value.slice(offset, offset + length),
        end: offset + length === value.length,
      });
      const length = fitPrefixLength(value, offset, (length) => fits(build(length)));
      const page = build(length);
      if ((!length && offset < value.length) || !fits(page))
        throw new ReviewerBudgetError('Capture detail metadata cannot fit with positive progress');
      yield page;
      index++;
      offset += length;
    } while (offset < value.length);
  }
  yield* walk(value, path);
}

export function validateMaterialization(
  value: unknown,
  record: FindingRecord,
  state: FoldedFinding,
  binding: {
    expected?: TaskSnapshot | null;
    allowNoop?: boolean;
    tracked?: boolean;
    questions?: (string | null | undefined)[];
  } = {},
): Omit<ProposalSubmission, 'references'> | null {
  const result = object(value);
  text(result['reason']);
  if (result['submission'] === null) {
    if (record.ambiguous || state.status === 'uncertain')
      throw new Error('Ambiguous capture requires a question');
    if (state.draft?.question || binding.questions?.some(Boolean))
      throw new Error('Capture must preserve unresolved questions');
    if (binding.tracked && !binding.allowNoop)
      throw new Error('Tracked capture requires a proposal or verified no-op');
    if (state.status !== 'completed' && state.status !== 'refused' && !binding.allowNoop)
      throw new Error('Active capture requires a proposal or verified no-op');
    return null;
  }
  const submission = object(result['submission']) as Omit<ProposalSubmission, 'references'>;
  if (
    Object.keys(submission).some(
      (key) => !['change', 'expected', 'question', 'explanation'].includes(key),
    )
  )
    throw new Error('Materialization cannot select references or proposal identity');
  validateIntent({
    change: submission.change,
    expected: submission.expected,
    question: submission.question,
  });
  text(submission.explanation);
  const questions = [submission.question, state.draft?.question, ...(binding.questions ?? [])];
  const question =
    [...new Set(questions.filter((item): item is string => !!item))].join('\n') || null;
  if (
    (record.ambiguous ||
      state.status === 'uncertain' ||
      state.status === 'refused' ||
      (state.status === 'completed' && submission.change.operation !== 'complete')) &&
    !question
  )
    throw new Error('Unsupported or ambiguous capture outcome requires a question');
  if (
    state.status === 'active' &&
    submission.change.operation === 'complete' &&
    state.draft?.change.operation !== 'complete' &&
    !question
  )
    throw new Error('Active evidence does not authorize completion');
  if (submission.change.operation !== 'add') {
    const intent = state.draft?.change;
    if (
      record.ambiguous ||
      submission.change.targetUuid !== binding.expected?.uuid ||
      (intent && intent.operation !== 'add' && intent.targetUuid !== submission.change.targetUuid)
    )
      throw new Error('Capture target was not uniquely matched to exact saved state');
  } else if (binding.expected && !question) {
    throw new Error('Matched existing task cannot become an unqualified add');
  }
  const bound = {
    ...submission,
    question,
    expected: submission.change.operation === 'add' ? null : (binding.expected ?? null),
  };
  validateDraft({ change: bound.change, expected: bound.expected, question: bound.question });
  return bound;
}
