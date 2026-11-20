import { expect, it } from 'vitest';
import { CaptureRetryableError } from '../extensions/remembrancer/capture-jobs.js';
import type { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import { readProposals, type ProposalReadArgs } from '../extensions/remembrancer/proposal-read.js';
import type { Proposal, ProposalSource } from '../extensions/remembrancer/proposals.js';
import { REVIEW_RESPONSE_MAX_BYTES } from '../extensions/remembrancer/review-pages.js';

function source(quote = 'Accepted promise', index = 0): ProposalSource {
  return {
    file: '/disposable/session.jsonl',
    sessionId: 'session',
    branchId: 'branch',
    entryId: `entry-${index}`,
    editId: null,
    role: 'user',
    timestamp: '2026-11-01',
    locator: `session/branch/entry-${index}`,
    offset: 17,
    quote,
  };
}
function proposal(id = 'proposal'): Proposal {
  return {
    id,
    revision: 3,
    state: 'pending',
    change: { operation: 'add', fields: { description: 'Send comparison' }, annotations: [] },
    draft: null,
    expected: null,
    question: null,
    explanation: 'Accepted promise',
    sources: [source()],
    result: null,
    claim: null,
    createdAt: '2026-11-01',
    updatedAt: '2026-11-01',
  };
}
function fixture(rows: Proposal[]) {
  const db = {
    proposals: (_state: unknown, offset: number, limit: number) =>
      rows.slice(offset, offset + limit),
    proposal: (id: string) => rows.find((row) => row.id === id),
  } as CheckpointStore;
  const read = (args: ProposalReadArgs = {}) => {
    const page = readProposals(db, args);
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(
      REVIEW_RESPONSE_MAX_BYTES,
    );
    return page;
  };
  return { db, read };
}

it('batches compact summaries and enumerates an unchanged list without skips or duplicates', () => {
  const rows = Array.from({ length: 47 }, (_, index) => proposal(`id-${index}`));
  rows[0]!.draft = {
    change: {
      operation: 'add',
      fields: { description: 'x'.repeat(159) + '😀'.repeat(1000) },
      annotations: [],
    },
    expected: null,
    question: 'Needs approval',
  };
  const { read } = fixture(rows);
  let offset = 0;
  const ids: string[] = [];
  do {
    const page = read({ offset });
    if (page.action !== 'list') throw new Error('Expected list');
    expect(page.proposals.length).toBeGreaterThan(1);
    expect(page.proposals.length).toBeLessThanOrEqual(20);
    const first = page.proposals[0]!;
    if (offset === 0) {
      expect(first).toMatchObject({
        label: 'x'.repeat(159),
        labelTruncated: true,
        hasDraft: true,
        hasQuestion: true,
        evidenceCount: 1,
      });
      expect(first).not.toHaveProperty('sources');
      expect(first).not.toHaveProperty('expected');
      expect(first).not.toHaveProperty('result');
      expect(first).not.toHaveProperty('draft');
      expect(first).not.toHaveProperty('history');
      expect(first).not.toHaveProperty('explanation');
    }
    ids.push(...page.proposals.map((row) => row.id));
    if (page.nextOffset === null) break;
    expect(page.nextOffset).toBe(offset + page.proposals.length);
    offset = page.nextOffset;
  } while (ids.length < rows.length);
  expect(ids).toEqual(rows.map((row) => row.id));
  expect(read({ offset: rows.length })).toEqual({
    action: 'list',
    proposals: [],
    nextOffset: null,
  });
});

it('uses the full encoded byte budget for list batches and advances only by returned count', () => {
  const rows = Array.from({ length: 20 }, (_, index) =>
    proposal(`${index}-` + '\u0000'.repeat(500)),
  );
  for (const row of rows)
    row.change = {
      operation: 'add',
      fields: { description: '\u0000'.repeat(200) },
      annotations: [],
    };
  const { read } = fixture(rows);
  const page = read();
  if (page.action !== 'list') throw new Error('Expected list');
  expect(page.proposals.length).toBeGreaterThan(1);
  expect(page.proposals.length).toBeLessThan(rows.length);
  expect(page.nextOffset).toBe(page.proposals.length);
  const next = read({ offset: page.nextOffset! });
  if (next.action !== 'list') throw new Error('Expected list');
  expect(next.proposals[0]!.id).toBe(rows[page.proposals.length]!.id);
});

it('budgets the final null list cursor before packing the last summary', () => {
  const rows = [proposal('first'), proposal('last')];
  const { read } = fixture(rows);
  const initial = read();
  rows[1]!.id += 'x'.repeat(
    REVIEW_RESPONSE_MAX_BYTES - Buffer.byteLength(JSON.stringify(initial)) + 1,
  );
  const first = read();
  if (first.action !== 'list') throw new Error('Expected list');
  expect(first.proposals.map((item) => item.id)).toEqual(['first']);
  expect(first.nextOffset).toBe(1);
  const last = read({ offset: first.nextOffset! });
  if (last.action !== 'list') throw new Error('Expected list');
  expect(last.proposals.map((item) => item.id)).toEqual([rows[1]!.id]);
  expect(last.nextOffset).toBeNull();
});

it.each(['😀漢字"\\\n\t\u0000', '\ud800', 'x'])(
  'losslessly chunks oversized current detail fields: %j',
  (pattern) => {
    const row = proposal();
    // Exceed one response per field without inflating escape-heavy fixtures to megabytes.
    const patternBytes = Buffer.byteLength(JSON.stringify(pattern), 'utf8') - 2;
    const text = pattern.repeat(Math.ceil(REVIEW_RESPONSE_MAX_BYTES / patternBytes));
    expect(Buffer.byteLength(JSON.stringify(text), 'utf8')).toBeGreaterThan(
      REVIEW_RESPONSE_MAX_BYTES,
    );
    row.explanation = text;
    row.draft = {
      change: { operation: 'add', fields: { description: text }, annotations: [text] },
      expected: null,
      question: text,
    };
    row.result = { state: 'uncertain', verified: null, error: text, actual: { raw: text } };
    const before = JSON.stringify(row);
    const { read } = fixture([row]);
    let args: ProposalReadArgs = { action: 'detail', id: row.id, revision: row.revision };
    let restored = '';
    let pages = 0;
    let page;
    do {
      page = read(args);
      if (page.action !== 'detail') throw new Error('Expected detail');
      expect(page.position).toBe(restored.length);
      expect(page.json.length).toBeGreaterThan(0);
      restored += page.json;
      pages++;
      if (!page.next) break;
      expect(page.next.position).toBe(restored.length);
      args = page.next;
    } while (page.next);
    expect(pages).toBeGreaterThan(1);
    const current = Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'sources'));
    expect(JSON.parse(restored)).toEqual(current);
    expect(JSON.stringify(row)).toBe(before);
  },
);

it('reconstructs huge exact quotes and many references with separate source offsets and safe positions', () => {
  const row = proposal();
  row.sources = [
    source('😀漢"\\\n\u0000'.repeat(35_000)),
    ...Array.from({ length: 241 }, (_, index) => source(`Exact quote ${index}`, index + 1)),
  ];
  const before = JSON.stringify(row);
  const { read } = fixture([row]);
  let args: ProposalReadArgs = { action: 'evidence', id: row.id, revision: row.revision };
  const quotes: string[] = [];
  let pages = 0;
  let page;
  do {
    page = read(args);
    if (page.action !== 'evidence') throw new Error('Expected evidence');
    expect(page.entries.length).toBeGreaterThan(0);
    for (const entry of page.entries) {
      const text = quotes[entry.index] ?? '';
      expect(entry.quotePosition).toBe(text.length);
      expect(entry.offset).toBe(17);
      expect(entry.file).toBe('/disposable/session.jsonl');
      expect(entry.entryId).toBe(`entry-${entry.index}`);
      quotes[entry.index] = text + entry.quote;
      if (entry.continues) expect(quotes[entry.index]).not.toMatch(/[\ud800-\udbff]$/u);
    }
    pages++;
    if (!page.next) break;
    args = page.next;
  } while (page.next);
  expect(pages).toBeGreaterThan(4);
  expect(quotes).toEqual(row.sources.map((entry) => entry.quote));
  expect(JSON.stringify(row)).toBe(before);
});

it.each(['detail', 'evidence'] as const)(
  'rejects stale/missing %s first and continuation reads without mutations',
  (action) => {
    const row = proposal();
    row.explanation = 'x'.repeat(90_000);
    row.sources = [source('x'.repeat(90_000))];
    const rows = [row];
    const { read } = fixture(rows);
    const args = { action, id: row.id, revision: row.revision };
    expect(() => read({ ...args, revision: 2 })).toThrow(CaptureRetryableError);
    expect(() => read({ ...args, revision: 2 })).toThrow(/Stale proposal/);
    expect(() => read({ ...args, id: 'absent' })).toThrow(CaptureRetryableError);
    expect(() => read({ ...args, id: 'absent' })).toThrow(/Missing proposal/);
    const first = read(args);
    if (first.action === 'list' || first.next === null) throw new Error('Expected continuation');
    row.revision++;
    const before = JSON.stringify(row);
    expect(() => read(first.next!)).toThrow(CaptureRetryableError);
    expect(() => read(first.next!)).toThrow(/Stale proposal/);
    expect(JSON.stringify(row)).toBe(before);
    rows.pop();
    expect(() => read(first.next!)).toThrow(CaptureRetryableError);
    expect(() => read(first.next!)).toThrow(/Missing proposal/);
  },
);

it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid numeric cursors %s',
  (bad) => {
    const row = proposal();
    const { read } = fixture([row]);
    expect(() => read({ offset: bad })).toThrow(/Invalid proposal/);
    expect(() => read({ action: 'detail', id: row.id, revision: 3, position: bad })).toThrow(
      /Invalid proposal/,
    );
    expect(() => read({ action: 'evidence', id: row.id, revision: 3, index: bad })).toThrow(
      /Invalid proposal/,
    );
    expect(() => read({ action: 'evidence', id: row.id, revision: 3, quotePosition: bad })).toThrow(
      /Invalid proposal/,
    );
    expect(() => read({ action: 'detail', id: row.id, revision: bad })).toThrow(/Invalid proposal/);
  },
);

it('rejects split surrogates, out-of-range and nonprogressing cursors, and impossible metadata', () => {
  const row = proposal();
  row.explanation = '😀';
  row.sources = [source('😀')];
  const { read } = fixture([row]);
  const detail = read({ action: 'detail', id: row.id, revision: 3 });
  if (detail.action !== 'detail') throw new Error('Expected detail');
  expect(() =>
    read({ action: 'detail', id: row.id, revision: 3, position: detail.json.indexOf('😀') + 1 }),
  ).toThrow(/surrogate/);
  expect(() => read({ action: 'detail', id: row.id, revision: 3, position: 99999 })).toThrow(
    /beyond/,
  );
  for (const cursor of [
    { index: 0, quotePosition: 1 },
    { index: 2 },
    { index: 1, quotePosition: 1 },
    { index: 0, quotePosition: 2 },
  ])
    expect(() => read({ action: 'evidence', id: row.id, revision: 3, ...cursor })).toThrow(
      /Invalid proposal/,
    );
  row.sources[0]!.file = 'x'.repeat(60_000);
  expect(() => read({ action: 'evidence', id: row.id, revision: 3 })).toThrow(
    /metadata or envelope cannot fit/,
  );
  row.id = 'x'.repeat(60_000);
  expect(() => read({ action: 'detail', id: row.id, revision: 3 })).toThrow(
    /metadata or envelope cannot fit/,
  );
  expect(() => read()).toThrow(/metadata or envelope cannot fit/);
});

it('rejects missing identity and action-specific cursor fields at the shared reader boundary', () => {
  const { read } = fixture([proposal()]);
  for (const args of [
    { action: 'unknown' },
    { id: 'proposal', revision: 3 },
    { action: 'detail', revision: 3 },
    { action: 'detail', id: 'proposal' },
    { action: 'detail', id: 'proposal', revision: 3, offset: 0 },
    { action: 'evidence', id: 'proposal', revision: 3, position: 0 },
  ])
    expect(() => read(args)).toThrow(
      expect.objectContaining({
        constructor: Error,
        message: expect.stringMatching(/Invalid proposal/),
      }),
    );
});

it('keeps a stored conflict question discoverable when an edited draft has no question', () => {
  const row = proposal();
  row.question = 'New evidence conflicts with this draft';
  row.draft = { change: row.change, expected: null, question: null };
  const page = fixture([row]).read();
  if (page.action !== 'list') throw new Error('Expected list');
  expect(page.proposals[0]).toMatchObject({ hasDraft: true, hasQuestion: true });
});

it('handles empty evidence and explicit terminal detail/evidence cursors', () => {
  const row = proposal();
  row.sources = [];
  const { read } = fixture([row]);
  expect(read({ action: 'evidence', id: row.id, revision: 3 })).toMatchObject({
    entries: [],
    next: null,
  });
  const page = read({ action: 'detail', id: row.id, revision: 3 });
  if (page.action !== 'detail') throw new Error('Expected detail');
  expect(
    read({ action: 'detail', id: row.id, revision: 3, position: page.json.length }),
  ).toMatchObject({ json: '', next: null });
});
