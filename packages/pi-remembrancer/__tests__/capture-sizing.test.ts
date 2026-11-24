import { expect, it } from 'vitest';
import {
  captureDetailPages,
  captureReplySize,
  extractionAllowance,
} from '../extensions/remembrancer/capture-sizing.js';
import {
  estimateReviewerTokens,
  ReviewerBudgetError,
} from '../extensions/remembrancer/reviewer-budget.js';
import { splitsSurrogatePair } from '../extensions/remembrancer/review-pages.js';

it.each([384, 512, 1024, 4096])(
  'reserves the complete worst-case extraction reply at %i',
  (ceiling) => {
    const end = Number.MAX_SAFE_INTEGER;
    const { count, textUnits } = extractionAllowance(ceiling, end);
    const answer = (size: number) => ({
      complete: false,
      observations: Array.from({ length: size }, () => ({
        kind: 'completion',
        label: '\u0000'.repeat(textUnits),
        observationId: '\u0000'.repeat(textUnits),
        start: end,
        end,
      })),
      nextObservationOffset: Number.MAX_SAFE_INTEGER,
      memory: '\u0000'.repeat(textUnits),
    });
    expect(count).toBeGreaterThan(0);
    expect(textUnits).toBeGreaterThan(0);
    expect(captureReplySize(answer(count))).toBeLessThanOrEqual(ceiling);
    expect(captureReplySize(answer(count + 1))).toBeGreaterThan(ceiling);
  },
);

it('rejects only when even a minimal bounded observation cannot fit', () => {
  expect(() => extractionAllowance(1, 1)).toThrow(ReviewerBudgetError);
  expect(extractionAllowance(384, 1).count).toBeGreaterThan(0);
});

it('packs escaped Unicode chunks and empty fields by the complete caller envelope', () => {
  const original = { text: '😀\n"\\'.repeat(30), empty: '', count: 3, array: [] };
  const size = (page: object) =>
    estimateReviewerTokens({
      instruction: JSON.stringify({ work: { page }, memory: 'current notes' }),
    });
  const pages = [...captureDetailPages(original, (page) => size(page) <= 240)];
  const strings = new Map<string, string>();
  const values = new Map<string, unknown>();
  for (const page of pages) {
    expect(size(page)).toBeLessThanOrEqual(240);
    for (const field of page.fields) {
      const key = field.path.join('.');
      if ('value' in field) values.set(key, field.value);
      else {
        const text = original[key as 'text' | 'empty'];
        expect(field.offset).toBe((strings.get(key) ?? '').length);
        expect(splitsSurrogatePair(text, field.offset)).toBe(false);
        expect(splitsSurrogatePair(text, field.offset + field.text.length)).toBe(false);
        expect(field.end).toBe(field.offset + field.text.length === text.length);
        strings.set(key, (strings.get(key) ?? '') + field.text);
      }
    }
  }
  expect(Object.fromEntries([...strings, ...values])).toEqual(original);
  expect(pages.some((page) => page.fields.length > 1)).toBe(true);
});
