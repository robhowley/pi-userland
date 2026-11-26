import { expect, it } from 'vitest';
import { detailPages } from '../extensions/remembrancer/review-findings.js';
import {
  estimateReviewerTokens,
  ReviewerBudgetError,
} from '../extensions/remembrancer/reviewer-budget.js';
import { splitsSurrogatePair } from '../extensions/remembrancer/review-pages.js';

it('fits every complete Unicode detail envelope and joins exact text at safe boundaries', () => {
  const limit = 100;
  const original = '😀\u0000"\\é\n'.repeat(100);
  let joined = '';
  const envelope = (page: object, index: number) => ({ page, index });
  for (const [index, page] of [...detailPages(original, limit, [], envelope)].entries()) {
    expect(estimateReviewerTokens(envelope(page, index))).toBeLessThanOrEqual(limit);
    const chunk = page as { offset: number; text: string; end: boolean };
    expect(chunk.offset).toBe(joined.length);
    expect(chunk.text.length).toBeGreaterThan(0);
    expect(splitsSurrogatePair(original, chunk.offset)).toBe(false);
    expect(splitsSurrogatePair(original, chunk.offset + chunk.text.length)).toBe(false);
    joined += chunk.text;
    expect(chunk.end).toBe(joined.length === original.length);
  }
  expect(joined).toBe(original);
});

it('uses the fitting two-unit scalar prefix rather than halving it away', () => {
  const limit = estimateReviewerTokens({ path: [], offset: 0, text: '😀', end: false });
  const pages = [...detailPages('😀xx', limit)] as { text: string }[];
  expect(pages[0]!.text).toBe('😀');
  expect(pages.map((page) => page.text).join('')).toBe('😀xx');
  for (const page of pages) expect(estimateReviewerTokens(page)).toBeLessThanOrEqual(limit);
});

it.each([null, 12345, {}, [], '', '😀'])(
  'fails explicitly if metadata or a scalar cannot fit: %j',
  (value) => {
    expect(() => [...detailPages(value, 1)]).toThrow(ReviewerBudgetError);
  },
);

it('fails explicitly on oversized field paths and scalar values rather than yielding oversized pages', () => {
  expect(() => [...detailPages({ ['x'.repeat(100)]: 1 }, 50)]).toThrow(ReviewerBudgetError);
  expect(() => [...detailPages(Infinity, 1)]).toThrow(ReviewerBudgetError);
});
