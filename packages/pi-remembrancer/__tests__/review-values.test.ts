import { expect, it, vi } from 'vitest';
import { detailPages } from '../extensions/remembrancer/review-findings.js';
import {
  estimateReviewerTokens,
  ReviewerBudgetError,
} from '../extensions/remembrancer/reviewer-budget.js';
import { splitsSurrogatePair } from '../extensions/remembrancer/review-pages.js';
import { ReviewValues } from '../extensions/remembrancer/review-values.js';

const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

it('sizing cannot authorize retained but unsent handles, including abandoned aggregate children', () => {
  const values = new ReviewValues(100, 200);
  const abandoned = values.working('a'.repeat(1000));
  const sent = values.working('b'.repeat(1000));
  expect(() => values.expand(wire(abandoned))).toThrow('handle');
  expect(() => values.page('v1', 0)).toThrow('cursor');
  values.issue({ work: sent });
  expect(values.expand(wire(sent))).toBe('b'.repeat(1000));
  expect(() => values.expand(wire(abandoned))).toThrow('handle');
  expect(() => values.page('v1', 0)).toThrow('cursor');
  // A model-shaped object assembled by a caller is not an issued host marker.
  values.issue(wire(abandoned));
  expect(() => values.expand(wire(abandoned))).toThrow('handle');
  expect(() => values.expand({ valueHandle: 'invented' })).toThrow('handle');
});

it('retains combined encoded aggregates as originals and issues only visible handles', () => {
  const values = new ReviewValues(100, 150);
  const child = values.working('x'.repeat(1000));
  const others = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field${i}`, i]));
  const combined = values.working({ child, ...others });
  expect(values.isHandle(combined)).toBe(true);
  values.issue(combined);
  expect(values.expand(wire(combined))).toEqual({ child: 'x'.repeat(1000), ...others });
  expect(() => values.expand(wire(child))).toThrow('handle');
});

it('round-trips arbitrary reserved custom fields without confusing them with transport markers', () => {
  const values = new ReviewValues(1000, 2000);
  const original = {
    valueHandle: 'v1',
    valueLiteral: [['arbitrary', { valueHandle: 'not-a-handle' }]],
    append: { valueLiteral: false, custom: true },
    nested: [{ valueHandle: { unusual: 'custom field' } }],
    ['__proto__']: { safe: true },
  };
  const working = values.working(original);
  expect(values.hasHandles(working)).toBe(false);
  expect(values.working(working)).toBe(working);
  values.issue(working);
  expect(values.expand(wire(working))).toEqual(original);
  expect(() =>
    values.expand({
      valueLiteral: [
        ['duplicate', 1],
        ['duplicate', 2],
      ],
    }),
  ).toThrow('literal');
});

it('preserves aggregate compact children, copy and append without replaying originals', () => {
  const values = new ReviewValues(100, 400);
  const original = Object.fromEntries(
    Array.from({ length: 5 }, (_, i) => [`field${i}`, 'x'.repeat(1000)]),
  );
  const working = values.working(original) as Record<string, unknown>;
  expect(values.isHandle(working)).toBe(false);
  expect(values.hasHandles(working)).toBe(true);
  expect(estimateReviewerTokens(working)).toBeLessThanOrEqual(400);
  values.issue(working);
  expect(values.expand(wire(working))).toEqual(original);
  expect(values.expand({ ...(working['field0'] as object), append: '!' })).toBe(
    'x'.repeat(1000) + '!',
  );
  const list = values.issue(values.working(Array.from({ length: 100 }, (_, i) => i)));
  expect(values.expand({ ...(list as object), append: [100] })).toEqual(
    Array.from({ length: 101 }, (_, i) => i),
  );
});

it('reuses equivalent freshly mapped histories and never restarts page traversal', () => {
  const values = new ReviewValues(150, 200);
  const history = Array.from({ length: 100 }, (_, i) => ({ id: i, label: 'x'.repeat(20) }));
  const working = values.issue(values.working(history));
  expect(values.working(history.map((entry) => ({ ...entry })))).toEqual(working);
  const handle = (working as { valueHandle: string }).valueHandle;
  // Each yielded field is encoded at most once for fit search plus final validation.
  const stringify = vi.spyOn(JSON, 'stringify');
  try {
    const first = values.page(handle, 0);
    const afterFirst = stringify.mock.calls.length;
    expect(values.page(handle, 0)).toEqual(first);
    expect(stringify.mock.calls.length).toBe(afterFirst);
    let index: number | null = first.nextIndex;
    let count = 1;
    while (index !== null) {
      const result = values.page(handle, index);
      expect(estimateReviewerTokens(result)).toBeLessThanOrEqual(150);
      index = result.nextIndex;
      count++;
    }
    expect(count).toBe(200);
    expect(stringify.mock.calls.length).toBeLessThan(1000);
  } finally {
    stringify.mockRestore();
  }
  expect(() => values.page(handle, 200)).toThrow('cursor');
});

it('fits every complete Unicode detail envelope and joins exact text at safe boundaries', () => {
  const limit = 100;
  const original = '😀\u0000"\\é\n'.repeat(100);
  const values = new ReviewValues(limit, 200);
  const working = values.issue(values.working(original)) as { valueHandle: string };
  let index: number | null = 0;
  let joined = '';
  while (index !== null) {
    const result = values.page(working.valueHandle, index);
    expect(estimateReviewerTokens(result)).toBeLessThanOrEqual(limit);
    const page = result.page as { offset: number; text: string; end: boolean };
    expect(page.offset).toBe(joined.length);
    expect(page.text.length).toBeGreaterThan(0);
    expect(splitsSurrogatePair(original, page.offset)).toBe(false);
    expect(splitsSurrogatePair(original, page.offset + page.text.length)).toBe(false);
    joined += page.text;
    expect(page.end).toBe(joined.length === original.length);
    index = result.nextIndex;
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
