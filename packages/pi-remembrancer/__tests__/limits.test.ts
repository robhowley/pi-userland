import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { discoverSources } from '../extensions/remembrancer/discovery.js';
import {
  prepareReview,
  readSession,
  ReviewBudget,
  REVIEW_LIMITS,
  ReviewLimitError,
} from '../extensions/remembrancer/evidence.js';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, readSync: vi.fn(fs.readSync) };
});
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const message = (id: string, parentId: string | null, text = id) => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2026-01-30',
  message: { role: 'user', content: text },
});
const lines = (...records: unknown[]) =>
  records.map((record) => JSON.stringify(record)).join('\n') + '\n';
function fixture() {
  const dir = fs.mkdtempSync(join(tmpdir(), 'remembrancer-limits-'));
  dirs.push(dir);
  const source = { file: join(dir, 'session.jsonl'), sessionId: 'session', seedSince: null };
  fs.writeFileSync(
    source.file,
    lines({ type: 'session', id: 'session' }, message('old', null), message('new', 'old')),
  );
  return source;
}

it.each([
  { recordBytes: 1 },
  { sourceEntries: 1 },
  { sourceTextBytes: 1 },
  { sourceBytes: 1 },
  { sourceBranches: 0 },
  { sourceBranchEntries: 1 },
])(
  'leaves failed source coverage and enrollment untouched and retries from its checkpoint: %j',
  (limits) => {
    const source = fixture();
    const checkpoint = { ...source, entryId: 'old', since: null };
    const discovery = discoverSources(
      dirname(source.file),
      [],
      '2026-01-01',
      false,
      new ReviewBudget(limits),
    );
    expect(discovery).toMatchObject({
      incomplete: true,
      sources: [],
      newSources: [],
      snapshots: [],
    });
    expect(discovery.warnings.map((warning) => warning.message).join()).toMatch(/limit exceeded/);
    const enrolled = discoverSources(
      dirname(source.file),
      [source],
      null,
      false,
      new ReviewBudget(limits),
    );
    expect(enrolled.sources).toEqual([]);
    const failed = prepareReview(
      [source],
      [checkpoint],
      { requestedSince: '2026-01-01' },
      [],
      new ReviewBudget(limits),
    );
    expect(failed).toMatchObject({
      incomplete: true,
      evidence: [],
      checkpoints: [],
      sourceDefaults: [],
      successfulSources: [],
      snapshots: [],
    });
    expect(failed.warnings.map((warning) => warning.message).join()).toMatch(/limit exceeded/);
    const retry = prepareReview([source], [checkpoint]);
    expect(retry.evidence.map((item) => item.entryId)).toEqual(['new']);
    expect(retry.checkpoints.map((item) => item.entryId)).toEqual(['new']);
  },
);

it.each([{ sources: 0 }, { totalEntries: 0 }, { totalBytes: 0 }, { totalTextBytes: 0 }])(
  'propagates aggregate exhaustion from discovery and preparation: %j',
  (limits) => {
    const source = fixture();
    expect(() =>
      discoverSources(dirname(source.file), [], null, false, new ReviewBudget(limits)),
    ).toThrow(ReviewLimitError);
    expect(() => prepareReview([source], [], undefined, [], new ReviewBudget(limits))).toThrow(
      ReviewLimitError,
    );
  },
);
it('propagates aggregate fanout exhaustion with discovery snapshots', () => {
  const source = fixture();
  const budget = new ReviewBudget({ totalBranchEntries: 0 });
  const discovery = discoverSources(dirname(source.file), [], null, false, budget);
  expect(() =>
    prepareReview(discovery.sources, [], undefined, discovery.snapshots, budget),
  ).toThrow(ReviewLimitError);
});

it.each(['append', 'truncate', 'rewrite', 'replace'] as const)(
  'checks fixed extent during %s',
  async (mutation) => {
    const source = fixture();
    const original = fs.readFileSync(source.file, 'utf8');
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    let changed = false;
    vi.mocked(fs.readSync).mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const count = actual.readSync(...args);
      if (!changed) {
        changed = true;
        if (mutation === 'append') fs.appendFileSync(source.file, lines(message('later', 'new')));
        if (mutation === 'truncate') fs.truncateSync(source.file, 1);
        if (mutation === 'rewrite') fs.writeFileSync(source.file, original.replace('2026', '2025'));
        if (mutation === 'replace') {
          fs.renameSync(source.file, source.file + '.old');
          fs.writeFileSync(source.file, original);
        }
      }
      return count;
    });
    if (mutation === 'append')
      expect([...readSession(source.file).entries.keys()]).toEqual(['old', 'new']);
    else expect(() => readSession(source.file)).toThrow(/changed|truncated/);
    vi.mocked(fs.readSync).mockImplementation(actual.readSync);
  },
);

it('reserves unique ordinary fallback paths instead of repeating failed reads', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'remembrancer-ordinary-paths-'));
  dirs.push(dir);
  const missing = { file: join(dir, 'missing.jsonl'), sessionId: 'missing' };
  const repeated = prepareReview(
    [missing, { ...missing, sessionId: 'same-path' }],
    [],
    undefined,
    [],
    new ReviewBudget({ sources: 1 }),
  );
  expect(repeated.incomplete).toBe(true);
  expect(repeated.warnings).toHaveLength(2);
  expect(repeated.checkpoints).toEqual([]);

  expect(() =>
    prepareReview(
      [missing, { file: join(dir, 'other.jsonl'), sessionId: 'other' }],
      [],
      undefined,
      [],
      new ReviewBudget({ sources: 1 }),
    ),
  ).toThrow(ReviewLimitError);
});

it('reuses one discovery snapshot reservation during preparation', () => {
  const source = fixture();
  const budget = new ReviewBudget({ sources: 1 });
  const discovery = discoverSources(
    dirname(source.file),
    [{ ...source, seedSince: null }],
    '2026-01-01',
    false,
    budget,
  );
  expect(discovery.snapshots).toHaveLength(1);
  const review = prepareReview(
    discovery.sources,
    [],
    { requestedSince: '2026-01-01' },
    discovery.snapshots,
    budget,
  );
  expect(review.incomplete).toBe(false);
  expect(review.evidence.map((item) => item.text)).toEqual(['old', 'new']);
});

it('does not charge a failed discovery path again when discovery is retried', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'remembrancer-discovery-repeat-'));
  dirs.push(dir);
  fs.writeFileSync(join(dir, 'broken.jsonl'), '{broken\n');
  const budget = new ReviewBudget({ sources: 1 });
  const first = discoverSources(dir, [], null, false, budget);
  const second = discoverSources(dir, [], null, false, budget);
  expect(first.warnings).toHaveLength(1);
  expect(second.warnings).toHaveLength(1);
  expect(first.incomplete).toBe(true);
  expect(second.incomplete).toBe(true);
});

it('fails after unique discovery candidates consume the source cap', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'remembrancer-discovery-paths-'));
  dirs.push(dir);
  fs.writeFileSync(join(dir, 'first.jsonl'), '{broken\n');
  fs.writeFileSync(join(dir, 'second.jsonl'), '{also broken\n');
  expect(() => discoverSources(dir, [], null, false, new ReviewBudget({ sources: 1 }))).toThrow(
    ReviewLimitError,
  );
});

it('rejects selected text before joining or serializing projected data', () => {
  const source = fixture();
  fs.writeFileSync(
    source.file,
    lines(
      { type: 'session', id: source.sessionId },
      {
        type: 'message',
        id: 'giant',
        parentId: null,
        timestamp: '2026-01-30',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'x'.repeat(1024) },
            { type: 'text', text: 'tail' },
          ],
        },
      },
    ),
  );
  const join = vi.spyOn(Array.prototype, 'join');
  const stringify = vi.spyOn(JSON, 'stringify');
  expect(() => readSession(source.file, { ...REVIEW_LIMITS, sourceTextBytes: 64 })).toThrow(
    /text\/metadata limit exceeded/,
  );
  expect(join).not.toHaveBeenCalled();
  expect(stringify).not.toHaveBeenCalled();
});

it('computes compact data cost without serializing selected text', () => {
  const source = fixture();
  fs.writeFileSync(
    source.file,
    lines({ type: 'session', id: source.sessionId }, message('selected', null, 'selected text')),
  );
  const stringify = vi.spyOn(JSON, 'stringify');
  expect(() => readSession(source.file, { ...REVIEW_LIMITS, sourceBytes: 64 })).toThrow(
    /text\/metadata limit exceeded/,
  );
  expect(stringify).not.toHaveBeenCalled();
});

it('rejects an oversized raw record before decoding or accumulating it', () => {
  const source = fixture();
  fs.writeFileSync(source.file, 'x'.repeat(70_000));
  const concat = vi.spyOn(Buffer, 'concat');
  const parse = vi.spyOn(JSON, 'parse');
  expect(() => readSession(source.file, { ...REVIEW_LIMITS, recordBytes: 4 })).toThrow(
    /raw record limit/,
  );
  expect(concat).not.toHaveBeenCalled();
  expect(parse).not.toHaveBeenCalled();
});

it.each([
  { type: 'session', id: '' },
  { type: 'session', id: '漢'.repeat(86) },
  { type: 'session', id: 'session', cwd: 'x'.repeat(16_385) },
])('rejects invalid or oversized source metadata: %j', (header) => {
  const source = fixture();
  fs.writeFileSync(source.file, lines(header));
  expect(() => readSession(source.file)).toThrow(/header|metadata/);
});
it('keeps unknown cwd and timestamps without retaining non-string metadata', () => {
  const source = fixture();
  fs.writeFileSync(
    source.file,
    lines({ type: 'session', id: 'session', cwd: {} }, { ...message('old', null), timestamp: {} }),
  );
  expect(readSession(source.file).cwd).toBe('(unknown)');
  const review = prepareReview([source], []);
  expect(review.evidence[0]?.timestamp).toBe('');
  expect(review.warnings.map((warning) => warning.message).join()).toMatch(/timestamp unknown/);
});
