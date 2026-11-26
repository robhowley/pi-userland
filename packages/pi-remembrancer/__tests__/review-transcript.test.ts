import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CaptureReview } from '../extensions/remembrancer/capture-review.js';
import { prepareReview } from '../extensions/remembrancer/evidence.js';
import { contextPage, splitsSurrogatePair } from '../extensions/remembrancer/review-pages.js';

const dirs: string[] = [];
afterEach(() => {
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
type ContextData = {
  groups: { entries: { text: string; offset: number }[] }[];
  nextOffset: number | null;
};
const selected = {
  sessionId: 'session',
  branchId: 'intent',
  entryId: 'intent',
  editId: null,
};

it('uses owned frozen branch context without acknowledging evidence or admitting context-only selections', () => {
  const review = fixture(
    [
      msg('prior', null, 'Supporting context'),
      msg('intent', 'prior', 'I will deliver '.repeat(30)),
    ],
    'prior',
  );
  const current = new CaptureReview(review, () => {});
  writeFileSync(review.snapshots[0]!.source.file, 'Changed after freezing');
  review.evidence.length = 0;
  for (let index = 0; index < 30; index++) {
    const context = current.context({ batch: current.id, selected });
    expect(JSON.stringify(context)).toContain('Supporting context');
  }
  expect(() => current.completion([])).toThrow('Read all evidence');
  expect(() =>
    current.context({ batch: current.id, selected: { ...selected, entryId: 'prior' } }),
  ).toThrow('not in this review batch');
  for (const page of current.preparePages()) page.accept();
  expect(() => current.completion([])).not.toThrow();
});

it('pages arbitrary same-message offsets with exact Unicode boundaries and real cursors', () => {
  const text = 'a😀b🛠️c𐐷d'.repeat(8000);
  const review = fixture([msg('intent', null, text)]);
  const current = new CaptureReview(review, () => {});
  let offset: number | null = 0;
  const quotes: string[] = [];
  while (offset !== null) {
    const data = contextPage('batch', selected, review.evidence, offset) as ContextData;
    expect(Buffer.byteLength(JSON.stringify(data), 'utf8')).toBeLessThanOrEqual(51_200);
    for (const group of data.groups)
      for (const entry of group.entries) {
        expect(splitsSurrogatePair(text, entry.offset)).toBe(false);
        expect(splitsSurrogatePair(text, entry.offset + entry.text.length)).toBe(false);
        expect(entry.text).toBe(text.slice(entry.offset, entry.offset + entry.text.length));
        quotes.push(entry.text);
      }
    if (data.nextOffset !== null) expect(data.nextOffset).toBeGreaterThan(offset);
    offset = data.nextOffset;
  }
  expect(quotes.join('')).toBe(text);
  expect(
    (contextPage('batch', selected, review.evidence, 3) as ContextData).groups[0]!.entries[0]!
      .offset,
  ).toBe(3);
  expect(current.validateReferences([{ ...selected, offset: 0, quote: 'a😀b' }])[0]!.quote).toBe(
    'a😀b',
  );
  expect(() =>
    current.validateReferences([{ ...selected, offset: 0, quote: text.slice(0, 5) }]),
  ).toThrow('eligible evidence');
  expect(() => contextPage('batch', selected, review.evidence, 2)).toThrow('surrogate pair');
  expect(() => contextPage('batch', selected, review.evidence, text.length + 1)).toThrow('beyond');
});

it('fits complete context envelopes with many entries and resumes without dropping text', () => {
  const earlier = '😀x'.repeat(1000);
  const records = Array.from({ length: 41 }, (_, index) =>
    msg('m' + index, index ? 'm' + (index - 1) : null, index === 40 ? 'I will send it.' : earlier),
  );
  const current = new CaptureReview(fixture(records, 'm39'), () => {});
  let offset: number | null = 0;
  const joined: string[] = [];
  let count = 0;
  do {
    const page = current.context({
      batch: current.id,
      selected: { ...selected, branchId: 'm40', entryId: 'm40' },
      before: 40,
      offset,
    }) as ContextData;
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(51_200);
    for (const group of page.groups) for (const entry of group.entries) joined.push(entry.text);
    if (page.nextOffset !== null) expect(page.nextOffset).toBeGreaterThan(offset);
    offset = page.nextOffset;
    count++;
  } while (offset !== null);
  expect(count).toBeGreaterThan(1);
  expect(joined.join('')).toBe(earlier.repeat(40));
  expect(() =>
    contextPage(
      'batch',
      selected,
      [{ ...fixture([msg('intent', null, 'x')]).evidence[0]!, cwd: 'x'.repeat(60_000) }],
      0,
    ),
  ).toThrow('cannot fit');
});

it('keeps equal source text separate when the surrounding branch roles differ', () => {
  const current = new CaptureReview(
    fixture([
      msg('root', null, 'I will send it.'),
      msg('a', 'root', 'Alice', 'user'),
      msg('b', 'root', 'Alice', 'assistant'),
    ]),
    () => {},
  );
  const groups = [...current.preparePages()].flatMap((page) => JSON.parse(page.text).groups) as {
    branchId: string;
    entries: { entryId: string; role: string; text: string }[];
  }[];
  expect(groups.find((group) => group.branchId === 'a')!.entries).toEqual([
    expect.objectContaining({ entryId: 'root', text: 'I will send it.' }),
    expect.objectContaining({ entryId: 'a', role: 'user', text: 'Alice' }),
  ]);
  expect(groups.find((group) => group.branchId === 'b')!.entries).toEqual([
    expect.objectContaining({ entryId: 'root', text: 'I will send it.' }),
    expect.objectContaining({ entryId: 'b', role: 'assistant', text: 'Alice' }),
  ]);
});
