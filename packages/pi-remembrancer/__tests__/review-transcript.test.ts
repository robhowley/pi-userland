import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareReview } from '../extensions/remembrancer/evidence.js';
import { estimateReviewerTokens } from '../extensions/remembrancer/reviewer-budget.js';
import { ReviewPlan } from '../extensions/remembrancer/review-plan.js';
import * as pages from '../extensions/remembrancer/review-pages.js';
import {
  exactQuote,
  messageContext,
  contextKey,
} from '../extensions/remembrancer/review-transcript.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const msg = (id: string, parentId: string | null, text: string, role = 'user') => ({
  type: 'message',
  id,
  parentId,
  message: { role, content: text },
});
function fixture(records: unknown[], checkpoint?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'review-transcript-'));
  dirs.push(dir);
  const source = { file: join(dir, 'session.jsonl'), sessionId: 'session' };
  writeFileSync(
    source.file,
    [{ type: 'session', id: 'session', cwd: dir }, ...records]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n',
  );
  return prepareReview(
    [source],
    checkpoint ? [{ ...source, entryId: checkpoint, since: null }] : [],
  );
}

it('builds each frozen branch view once across range sizing, surrounding and context reads', () => {
  const review = fixture(
    [
      msg('prior', null, 'Supporting context'),
      msg('intent', 'prior', 'I will deliver '.repeat(30)),
    ],
    'prior',
  );
  const read = vi.spyOn(pages, 'frozenBranch');
  const plan = new ReviewPlan(review);
  let count = 0;
  for (let range = plan.next(11); range; range = plan.next(11)) {
    plan.surrounding(range, 3);
    plan.next(5); // Model-independent sizing can replace a pending range.
    range = plan.next(11)!;
    plan.surrounding(range, 2);
    plan.context('batch', range.occurrences[0]!, { textUnits: 4 });
    plan.acceptExtraction(range);
    count++;
  }
  plan.assertComplete();
  expect(count).toBeGreaterThan(30);
  expect(read).toHaveBeenCalledTimes(1);
  // A cached branch must not make context-only entries eligible selections.
  expect(() =>
    plan.context('batch', {
      sessionId: 'session',
      branchId: 'intent',
      entryId: 'prior',
      editId: null,
    }),
  ).toThrow('not in this review batch');
});

it('pages arbitrary same-message offsets with exact Unicode boundaries and real cursors', () => {
  const text = 'a😀b🛠️c𐐷d';
  const plan = new ReviewPlan(fixture([msg('intent', null, text)]));
  const first = plan.next(3)!;
  plan.acceptExtraction(first);
  const second = plan.next(3)!;
  let offset: number | null = 0;
  const quotes: string[] = [];
  while (offset !== null) {
    const data = messageContext(second, 0, offset, 3);
    for (const group of data.groups)
      for (const entry of group.entries) {
        expect(entry.text.length).toBeLessThanOrEqual(3);
        expect(pages.splitsSurrogatePair(text, entry.offset)).toBe(false);
        expect(pages.splitsSurrogatePair(text, entry.offset + entry.text.length)).toBe(false);
        expect(entry.text).toBe(text.slice(entry.offset, entry.offset + entry.text.length));
        quotes.push(entry.text);
      }
    if (data.nextOffset !== null) expect(data.nextOffset).toBeGreaterThan(offset);
    offset = data.nextOffset;
  }
  expect(quotes.join('')).toBe(text);
  expect(exactQuote(second, 0, 4)).toBe('a😀b');
  expect(() => exactQuote(second, 0, 5)).toThrow('Invalid exact');
  expect(() => messageContext(second, 0, 2, 3)).toThrow('surrogate pair');
  expect(() => messageContext(second, 0, text.length + 1, 3)).toThrow('beyond');
});

it('fits complete context envelopes with many short entries and resumes without dropping text', () => {
  const records = Array.from({ length: 41 }, (_, index) =>
    msg('m' + index, index ? 'm' + (index - 1) : null, index === 40 ? 'I will send it.' : '😀x'),
  );
  const plan = new ReviewPlan(fixture(records, 'm39'));
  const selected = plan.next()!.occurrences[0]!;
  let offset: number | null = 0;
  const joined: string[] = [];
  let count = 0;
  do {
    const page = plan.context('batch', selected, {
      before: 40,
      offset,
      textUnits: 200,
      tokenLimit: 900,
    }) as ReturnType<typeof messageContext>;
    expect(estimateReviewerTokens(page)).toBeLessThanOrEqual(900);
    for (const group of page.groups) for (const entry of group.entries) joined.push(entry.text);
    if (page.nextOffset !== null) expect(page.nextOffset).toBeGreaterThan(offset);
    offset = page.nextOffset;
    count++;
  } while (offset !== null);
  expect(count).toBeGreaterThan(1);
  expect(joined.join('')).toBe('😀x'.repeat(40));
  expect(() =>
    plan.context('batch', selected, { before: 40, textUnits: 200, tokenLimit: 1 }),
  ).toThrow('positive progress');
});

it('keeps equal source text separate when the surrounding branch roles differ', () => {
  const plan = new ReviewPlan(
    fixture([
      msg('root', null, 'I will send it.'),
      msg('a', 'root', 'Alice', 'user'),
      msg('b', 'root', 'Alice', 'assistant'),
    ]),
  );
  const range = plan.next()!;
  expect(contextKey(range, 'a')).not.toBe(contextKey(range, 'b'));
});
