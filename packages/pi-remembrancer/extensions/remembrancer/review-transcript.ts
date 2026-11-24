import type { Evidence } from './evidence.js';
import type { PlannedRange } from './review-plan.js';
import {
  groupEvidencePage,
  fitPrefixLength,
  safePrefixLength,
  splitsSurrogatePair,
  type Selected,
} from './review-pages.js';

import { estimateReviewerTokens, ReviewerBudgetError } from './reviewer-budget.js';

// Full frozen messages never enter a working value or a provider payload by accident.
const sources = new WeakMap<PlannedRange, { evidence: Evidence; contexts: readonly string[] }>();
export function retainRange(range: PlannedRange, evidence: Evidence, contexts: readonly string[]) {
  sources.set(range, { evidence, contexts });
  return range;
}

export function contextKey(range: PlannedRange, branchId: string): string {
  return sources.get(range)!.contexts[
    range.occurrences.findIndex((item) => item.branchId === branchId)
  ]!;
}

export function exactQuote(range: PlannedRange, start: number, end: number): string {
  const evidence = sources.get(range)?.evidence;
  const text = evidence?.text ?? range.text;
  const base = evidence ? 0 : range.offset;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < base ||
    end <= start ||
    end > base + text.length ||
    splitsSurrogatePair(text, start - base) ||
    splitsSurrogatePair(text, end - base)
  )
    throw new Error('Invalid exact capture observation');
  return text.slice(start - base, end - base);
}

/** Exact pages for internal review steps, with a cursor in the requested frozen window. */
export function transcriptPage(
  batch: string,
  selected: Selected,
  items: readonly Evidence[],
  offset: number,
  units: number,
  envelope: Record<string, unknown> = {},
  tokenLimit = Infinity,
  envelopeFits: (page: unknown) => boolean = () => true,
) {
  if (!Number.isSafeInteger(units) || units < 2 || !Number.isSafeInteger(offset) || offset < 0)
    throw new Error('Invalid capture context cursor or text allowance');
  const total = items.reduce((sum, item) => sum + item.text.length, 0);
  if (offset > total) throw new Error('Context offset is beyond the requested range');
  const entries: (Evidence & { offset: number; continues: boolean })[] = [];
  const build = (page: typeof entries, cursor: number) => ({
    ...envelope,
    batch,
    selected,
    contextOnly: true,
    groups: groupEvidencePage(page),
    nextOffset: cursor < total ? cursor : null,
  });
  const fits = (page: typeof entries, cursor: number) =>
    estimateReviewerTokens(build(page, cursor)) <= tokenLimit && envelopeFits(build(page, cursor));
  let position = 0;
  let cursor = offset;
  let remaining = units;
  for (const item of items) {
    const end = position + item.text.length;
    if (end <= offset) {
      position = end;
      continue;
    }
    const start = Math.max(0, cursor - position);
    if (splitsSurrogatePair(item.text, start))
      throw new Error('Context offset splits a surrogate pair');
    const maximum = safePrefixLength(item.text, start, remaining);
    const entry = (length: number) => ({
      ...item,
      text: item.text.slice(start, start + length),
      offset: start,
      continues: start + length < item.text.length,
    });
    const length = fitPrefixLength(item.text.slice(start, start + maximum), 0, (length) =>
      fits([...entries, entry(length)], cursor + length),
    );
    if (!length) break;
    entries.push(entry(length));
    cursor += length;
    remaining -= length;
    position = end;
    if (remaining < 2) break;
  }
  if ((cursor === offset && offset < total) || !fits(entries, cursor))
    throw new ReviewerBudgetError('Capture context metadata cannot fit with positive progress');
  return build(entries, cursor);
}

export function messageContext(
  range: PlannedRange,
  occurrence: number,
  offset: number,
  units: number,
  batch = '',
  tokenLimit = Infinity,
  envelopeFits: (page: unknown) => boolean = () => true,
) {
  const source = sources.get(range);
  const selected = range.occurrences[occurrence];
  if (!source || !selected) throw new Error('Unknown capture message context');
  return transcriptPage(
    batch,
    selected,
    [{ ...source.evidence, ...selected, text: source.evidence.text }],
    offset,
    units,
    { message: true },
    tokenLimit,
    envelopeFits,
  );
}
