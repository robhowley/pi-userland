import { expect, it } from 'vitest';
import { readProposals } from '../extensions/remembrancer/proposal-read.js';
import type { Proposal } from '../extensions/remembrancer/proposals.js';
import {
  REVIEW_RESPONSE_MAX_BYTES,
  serializedResponse,
} from '../extensions/remembrancer/review-pages.js';

function proposal(): Proposal {
  return {
    id: 'proposal-1',
    revision: 2,
    change: { operation: 'add', fields: { description: 'Send comparison' }, annotations: [] },
    expected: null,
    question: null,
    draft: null,
    explanation: 'Accepted obligation',
    sources: [],
    state: 'pending',
    claim: null,
    result: null,
    createdAt: '2026-11-18',
    updatedAt: '2026-11-18',
  };
}

function store(rows: Proposal[]) {
  return {
    proposals: (_state: unknown, offset = 0, limit = 50) => rows.slice(offset, offset + limit),
    proposal: (id: string) => rows.find((row) => row.id === id),
  };
}

function reassemble(db: ReturnType<typeof store>, page: ReturnType<typeof readProposals>) {
  let text = '';
  let chunks = 0;
  const nextOffset = page.nextOffset;
  for (;;) {
    const encoded = serializedResponse(page);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(REVIEW_RESPONSE_MAX_BYTES);
    expect(JSON.parse(encoded)).toEqual(page);
    if (!('proposalChunk' in page)) throw new Error('Expected a proposal chunk');
    expect(page.proposals).toEqual([]);
    expect(page.nextOffset).toBe(nextOffset);
    expect(page.proposalChunk.position).toBe(text.length);
    expect(page.proposalChunk.text.length).toBeGreaterThan(0);
    expect(page.proposalChunk.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
    text += page.proposalChunk.text;
    expect(++chunks).toBeLessThan(1000);
    if (page.nextContinuation === null) break;
    expect(page.nextContinuation).toEqual({
      id: page.proposalChunk.id,
      revision: page.proposalChunk.revision,
      offset: nextOffset! - 1,
      position: text.length,
    });
    page = readProposals(db, { continuation: page.nextContinuation });
  }
  return { proposal: JSON.parse(text) as Proposal, nextOffset, chunks };
}

it('serializes and reconstructs an oversized synthetic history', () => {
  const saved = proposal();
  saved.history = Array.from({ length: 100 }, () => ({
    ...proposal(),
    explanation: 'Historical explanation '.repeat(50),
  }));
  const db = store([saved]);
  const response = readProposals(db, {});
  expect(() => serializedResponse(response)).not.toThrow();
  const result = reassemble(db, response);
  expect(result.proposal).toEqual(saved);
  expect(result.chunks).toBeGreaterThan(1);
});

it('preserves exact small and empty response shapes, including the terminal empty read', () => {
  const saved = proposal();
  const next = { ...proposal(), id: 'proposal-2' };
  const db = store([saved, next]);
  expect(readProposals(db, {})).toEqual({ proposals: [saved], nextOffset: 1 });
  expect(readProposals(db, { offset: 1 })).toEqual({ proposals: [next], nextOffset: 2 });
  expect(readProposals(db, { offset: 2 })).toEqual({ proposals: [], nextOffset: null });
  expect(readProposals(store([]), {})).toEqual({ proposals: [], nextOffset: null });
});

it.each([0, 1])('handles a response at the byte limit plus %i bytes', (extra) => {
  const saved = { ...proposal(), explanation: '' };
  const baseBytes = Buffer.byteLength(JSON.stringify({ proposals: [saved], nextOffset: 1 }));
  saved.explanation = 'x'.repeat(REVIEW_RESPONSE_MAX_BYTES - baseBytes + extra);
  const db = store([saved]);
  const page = readProposals(db, {});
  if (extra === 0) {
    expect(page).toEqual({ proposals: [saved], nextOffset: 1 });
    expect(Buffer.byteLength(serializedResponse(page))).toBe(REVIEW_RESPONSE_MAX_BYTES);
  } else {
    expect(reassemble(db, page).proposal).toEqual(saved);
  }
});

it.each(['current', 'draft', 'quote', 'result', 'history entry'])(
  'losslessly chunks a single oversized %s field',
  (field) => {
    const saved = proposal();
    const text = 'Synthetic content '.repeat(7000);
    switch (field) {
      case 'current':
        saved.change = { operation: 'add', fields: { description: text }, annotations: [] };
        break;
      case 'draft':
        saved.draft = { change: saved.change, expected: null, question: text };
        break;
      case 'quote':
        saved.sources = [
          {
            sessionId: 'session',
            branchId: 'branch',
            entryId: 'entry',
            editId: null,
            offset: 0,
            quote: text,
            file: '/synthetic/session.jsonl',
            role: 'user',
            timestamp: '2026-11-18',
            locator: 'synthetic',
          },
        ];
        break;
      case 'result':
        saved.result = { state: 'uncertain', verified: null, error: text, actual: { text } };
        break;
      case 'history entry':
        saved.history = [{ ...proposal(), explanation: text }];
        break;
    }
    const db = store([saved]);
    expect(reassemble(db, readProposals(db, {})).proposal).toEqual(saved);
  },
);

it.each(['é', '漢', '😀', '"\\\n\t', '\uD800', '\uDC00', '😀"\\\n漢\uD800'])(
  'makes bounded, lossless progress with Unicode and escaping (%j)',
  (text) => {
    const saved = { ...proposal(), explanation: text.repeat(REVIEW_RESPONSE_MAX_BYTES) };
    const db = store([saved]);
    expect(reassemble(db, readProposals(db, {})).proposal).toEqual(saved);
  },
);

it.each(['revision changed', 'missing'])(
  'rejects a continuation whose proposal is %s',
  (change) => {
    const saved = { ...proposal(), explanation: 'x'.repeat(100_000) };
    const rows = [saved];
    const db = store(rows);
    const page = readProposals(db, {});
    if (!('nextContinuation' in page) || !page.nextContinuation)
      throw new Error('Expected a continuation');
    const continuation = page.nextContinuation;
    if (change === 'missing') rows.pop();
    else saved.revision++;
    expect(() => readProposals(db, { continuation })).toThrow(
      /missing or its revision changed.*restart at offset zero/u,
    );
  },
);

it.each([
  { offset: -1 },
  { offset: 0.5 },
  { offset: Number.MAX_SAFE_INTEGER },
  { offset: NaN },
  { offset: Infinity },
  { offset: null },
  { continuation: null },
  { continuation: {} },
  ...[
    { id: '' },
    { revision: 0 },
    { revision: 1.5 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { offset: -1 },
    { offset: 0.5 },
    { offset: Number.MAX_SAFE_INTEGER },
    { position: -1 },
    { position: 0.5 },
    { position: Number.MAX_SAFE_INTEGER + 1 },
    { position: 1_000_000 },
  ].map((invalid) => ({
    continuation: { id: 'proposal-1', revision: 2, offset: 0, position: 1, ...invalid },
  })),
  { offset: 0, continuation: { id: 'proposal-1', revision: 2, offset: 0, position: 1 } },
])('rejects invalid read arguments %j', (args) => {
  expect(() =>
    readProposals(store([proposal()]), args as unknown as Parameters<typeof readProposals>[1]),
  ).toThrow(/Invalid proposal|either proposal offset or continuation/u);
});

it('rejects positions at the end of the text or inside a surrogate pair', () => {
  const saved = { ...proposal(), explanation: '😀'.repeat(30_000) };
  const text = JSON.stringify(saved);
  for (const position of [text.length, text.indexOf('😀') + 1]) {
    expect(() =>
      readProposals(store([saved]), {
        continuation: { id: saved.id, revision: saved.revision, offset: 0, position },
      }),
    ).toThrow(/Invalid proposal continuation position/u);
  }
});

it('resolves continuations by stable ID after the live list moves', () => {
  const saved = { ...proposal(), explanation: 'x'.repeat(100_000) };
  const rows = [saved];
  const db = store(rows);
  const page = readProposals(db, {});
  rows.unshift({ ...proposal(), id: 'inserted-before' });
  expect(reassemble(db, page).proposal).toEqual(saved);
});

it('returns the next proposal once after all chunks, followed by the terminal empty read', () => {
  const saved = { ...proposal(), explanation: 'x'.repeat(100_000) };
  const next = { ...proposal(), id: 'proposal-2' };
  const db = store([saved, next]);
  const result = reassemble(db, readProposals(db, {}));
  expect(result.proposal).toEqual(saved);
  const page = readProposals(db, { offset: result.nextOffset! });
  expect(page).toEqual({ proposals: [next], nextOffset: 2 });
  expect(readProposals(db, { offset: page.nextOffset! })).toEqual({
    proposals: [],
    nextOffset: null,
  });
});

it('fails clearly instead of returning a non-progressing chunk when metadata cannot fit', () => {
  const saved = { ...proposal(), id: 'x'.repeat(REVIEW_RESPONSE_MAX_BYTES) };
  expect(() => readProposals(store([saved]), {})).toThrow(
    /cannot fit proposal text.*metadata or envelope cannot fit/u,
  );
});
