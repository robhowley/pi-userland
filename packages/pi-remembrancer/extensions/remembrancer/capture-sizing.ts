import { fitPrefixLength } from './review-pages.js';
import { estimateReviewerTokens, ReviewerBudgetError } from './reviewer-budget.js';

/** Include the tool name and argument envelope, not only the answer's variable fields. */
export function captureReplySize(answer: unknown): number {
  return estimateReviewerTokens({
    name: 'remembrancer_step',
    arguments: { result: { answer } },
  });
}

/** Bound escaped labels, stable observation IDs, memory and the largest legal cursors. */
export function extractionAllowance(output: number, end: number) {
  const build = (units: number, count: number) => ({
    complete: false,
    observations: Array.from({ length: count }, () => ({
      kind: 'completion',
      label: '\u0000'.repeat(units),
      observationId: '\u0000'.repeat(units),
      start: end,
      end,
    })),
    nextObservationOffset: Number.MAX_SAFE_INTEGER,
    memory: '\u0000'.repeat(units),
  });
  let textUnits = 48;
  while (textUnits > 0 && captureReplySize(build(textUnits, 1)) > output) textUnits--;
  if (!textUnits)
    throw new ReviewerBudgetError('Capture minimum observation response cannot fit this model');
  let count = 1;
  while (captureReplySize(build(textUnits, count + 1)) <= output) count++;
  return { textUnits, count };
}

export type CaptureField =
  | { path: (string | number)[]; value: unknown }
  | { path: (string | number)[]; offset: number; text: string; end: boolean };

/** Greedy exact field/chunk batches, measured with the caller's complete current envelope. */
export function* captureDetailPages(
  value: unknown,
  fits: (page: { fields: CaptureField[] }) => boolean,
): Generator<{ fields: CaptureField[] }> {
  let fields: CaptureField[] = [];
  function* leaves(value: unknown, path: (string | number)[]): Generator<[unknown, typeof path]> {
    if (value !== null && typeof value === 'object' && Object.keys(value).length) {
      for (const [key, child] of Object.entries(value)) yield* leaves(child, [...path, key]);
    } else yield [value, path];
  }
  for (const [valueAtPath, path] of leaves(value, [])) {
    if (typeof valueAtPath !== 'string') {
      const field = { path, value: valueAtPath };
      if (fields.length && !fits({ fields: [...fields, field] })) {
        yield { fields };
        fields = [];
      }
      if (!fits({ fields: [...fields, field] }))
        throw new ReviewerBudgetError('Capture detail metadata cannot fit');
      fields.push(field);
      continue;
    }
    let offset = 0;
    do {
      const field = (length: number): CaptureField => ({
        path,
        offset,
        text: valueAtPath.slice(offset, offset + length),
        end: offset + length === valueAtPath.length,
      });
      let length = fitPrefixLength(valueAtPath, offset, (length) =>
        fits({ fields: [...fields, field(length)] }),
      );
      if (
        fields.length &&
        ((!length && offset < valueAtPath.length) || !fits({ fields: [...fields, field(length)] }))
      ) {
        yield { fields };
        fields = [];
        length = fitPrefixLength(valueAtPath, offset, (length) =>
          fits({ fields: [field(length)] }),
        );
      }
      if ((!length && offset < valueAtPath.length) || !fits({ fields: [...fields, field(length)] }))
        throw new ReviewerBudgetError('Capture detail metadata cannot fit with positive progress');
      fields.push(field(length));
      offset += length;
      if (offset < valueAtPath.length) {
        yield { fields };
        fields = [];
      }
    } while (offset < valueAtPath.length);
  }
  if (fields.length) yield { fields };
}
