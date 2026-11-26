import { expect, it } from 'vitest';
import { captureDetailPages } from '../extensions/remembrancer/capture-sizing.js';
import { estimateReviewerTokens } from '../extensions/remembrancer/reviewer-budget.js';
import { splitsSurrogatePair } from '../extensions/remembrancer/review-pages.js';

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
