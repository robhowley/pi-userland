import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckpointStore } from '../extensions/remembrancer/checkpoints.js';
import {
  prepareHistoricalReview,
  prepareReview,
  readSession,
  resolveSeedSince,
  type Checkpoint,
  type PreparedReview,
  type ReviewOptions,
  type SessionTree,
  type Source,
} from '../extensions/remembrancer/evidence.js';
import { frozenContext } from '../extensions/remembrancer/review-pages.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'remembrancer-historical-proof-'));
  dirs.push(dir);
  return dir;
}
const lines = (...records: unknown[]) =>
  records.map((record) => JSON.stringify(record)).join('\n') + '\n';
const msg = (id: string, parentId: string | null, timestamp = '2026-01-20T00:00:00.000Z') => ({
  type: 'message',
  id,
  parentId,
  timestamp,
  message: { role: 'user', content: id },
});
const edit = (id: string, parentId: string, targetId: string, content: string | null) => ({
  type: 'context_edit',
  id,
  parentId,
  targetId,
  timestamp: '2026-01-25T00:00:00.000Z',
  replacement: content === null ? null : { content },
});
function fixture(...records: unknown[]) {
  const dir = directory();
  const source: Source = { sessionId: 'historical-session', file: join(dir, 'original.jsonl') };
  const snapshotFile = join(dir, 'retained.jsonl');
  const bytes = lines({ type: 'session', id: source.sessionId, cwd: '/historical' }, ...records);
  writeFileSync(source.file, bytes);
  writeFileSync(snapshotFile, bytes);
  return { source, snapshotFile };
}
type Fixture = ReturnType<typeof fixture>;
const checkpoint = (f: Fixture, entryId: string, since: string | null = null): Checkpoint => ({
  file: f.source.file,
  sessionId: f.source.sessionId,
  entryId,
  since,
});

// Test-local applicability prototype, not a new production API. Parse one captured
// byte buffer, not a pathname re-read after prefix verification. These scratch
// files only let the existing parser consume those exact bytes.
function parseBytes(bytes: Buffer, source: Source): SessionTree {
  const file = join(directory(), 'coverage-view.jsonl');
  writeFileSync(file, bytes, { mode: 0o600 });
  const tree = readSession(file);
  if (tree.sessionId !== source.sessionId) throw Error('Session identity differs from snapshot');
  return { ...tree, tips: tree.tips.map((tip) => ({ ...tip, file: source.file })) };
}
// The proof now exercises the production applicability adapter.
type Applicability = ReturnType<typeof prepareHistoricalReview>;
function historicalReview(f: Fixture, reviewed: readonly Checkpoint[], options?: ReviewOptions) {
  return prepareHistoricalReview(f.source, f.snapshotFile, reviewed, options);
}
function prepared(result: Applicability): PreparedReview {
  expect(result.status, result.diagnostic ?? '').not.toBe('blocked');
  if (!result.review) throw Error(result.diagnostic);
  return result.review;
}
const selections = (review: PreparedReview) =>
  review.evidence.map((item) => [item.branchId, item.entryId, item.editId, item.text]);

// No SDK session/model/worker is involved. Production parser, applicability,
// manual coverage store and frozen-context contracts are exercised directly.
describe('historical coverage applicability proof', () => {
  it('reproduces the absent descendant B problem and subtracts its proven coverage from tip A', () => {
    const f = fixture(msg('root', null), msg('A', 'root'));
    appendFileSync(f.source.file, lines(msg('B', 'A')));
    const store = new CheckpointStore(':memory:');
    try {
      store.enroll(f.source.sessionId, f.source.file);
      const manual = prepareReview([f.source], []);
      store.finish({ checkpoints: manual.checkpoints });
      const committed = store.reviewed();
      expect(committed).toEqual([checkpoint(f, 'B')]);
      const oldSnapshot = prepareReview([f.source], committed, undefined, [
        { source: f.source, tree: parseBytes(readFileSync(f.snapshotFile), f.source) },
      ]);
      expect(oldSnapshot.incomplete).toBe(true);
      expect(oldSnapshot.evidence).toEqual([]);
      expect(oldSnapshot.warnings[0]?.reason).toContain('Review boundary unavailable: B');

      const result = historicalReview(f, committed);
      expect(result.status).toBe('already-covered');
      const review = prepared(result);
      expect(review.evidence).toEqual([]);
      expect(review.checkpoints).toEqual([]);
      expect(review.coverageChanged).toBe(false);
      expect(store.reviewed()).toEqual(committed);
      expect(review.snapshots[0]?.tree.entries.has('B')).toBe(false);
    } finally {
      store.close();
    }
  });

  it('uses later edits only for coverage, never for evidence or supporting context', () => {
    const f = fixture(msg('root', null), msg('A', 'root'));
    appendFileSync(
      f.source.file,
      lines(edit('edit-A', 'A', 'A', 'LATER REPLACEMENT'), msg('B', 'edit-A')),
    );
    const review = prepared(historicalReview(f, [checkpoint(f, 'B')]));
    expect(selections(review)).toEqual([['A', 'A', null, 'A']]);
    expect(review.checkpoints).toEqual([checkpoint(f, 'A')]);
    expect(review.evidence[0]?.file).toBe(f.source.file);
    const selected = review.evidence[0]!;
    const context = frozenContext(review, 'historical', { selected, before: 40, offset: 0 });
    expect(context).toMatchObject({
      contextOnly: true,
      groups: [{ entries: [{ entryId: 'root', text: 'root' }] }],
      nextOffset: null,
    });
    expect(JSON.stringify({ review, context })).not.toContain('LATER REPLACEMENT');
    expect(() => frozenContext(review, 'historical', { selected, before: 41 })).toThrow(
      'from 1 to 40',
    );
  });

  it('paginates preserved supporting text with the existing context offsets', () => {
    const text = 'preserved 😀 '.repeat(6_000);
    const f = fixture(
      { ...msg('root', null), message: { role: 'user', content: text } },
      msg('A', 'root'),
    );
    appendFileSync(f.source.file, lines(edit('edit', 'A', 'A', 'later text'), msg('B', 'edit')));
    const review = prepared(historicalReview(f, [checkpoint(f, 'B')]));
    const selected = review.evidence[0]!;
    type Context = { groups: { entries: { text: string }[] }[]; nextOffset: number | null };
    let offset = 0;
    let joined = '';
    do {
      const page = frozenContext(review, 'historical', { selected, before: 40, offset }) as Context;
      joined += page.groups.flatMap((group) => group.entries.map((entry) => entry.text)).join('');
      if (page.nextOffset === null) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    } while (offset < text.length);
    expect(offset).toBeGreaterThan(0);
    expect(joined).toBe(text);
    expect(review.snapshots[0]?.tree.entries.has('B')).toBe(false);
  });

  it('keeps all saved leaves and never inherits a sibling checkpoint, even for shared text', () => {
    const f = fixture(msg('root', null), msg('A', 'root'), msg('sibling', 'root'));
    appendFileSync(f.source.file, lines(msg('B', 'A')));
    const review = prepared(historicalReview(f, [checkpoint(f, 'B')]));
    expect(selections(review)).toEqual([
      ['sibling', 'root', null, 'root'],
      ['sibling', 'sibling', null, 'sibling'],
    ]);
    // A is already covered, but both preserved branches remain available for context.
    expect(review.snapshots[0]?.tree.tips.map((tip) => tip.entryId)).toEqual(['A', 'sibling']);
    expect(review.evidence.some((item) => item.branchId === 'B')).toBe(false);
  });

  it('allows ancestor coverage on both siblings but not sibling-specific coverage', () => {
    const f = fixture(msg('root', null), msg('A', 'root'), msg('sibling', 'root'));
    appendFileSync(f.source.file, lines(msg('B', 'A')));
    const review = prepared(historicalReview(f, [checkpoint(f, 'root'), checkpoint(f, 'B')]));
    expect(selections(review)).toEqual([['sibling', 'sibling', null, 'sibling']]);
  });

  it('matches exact edit IDs, not equal replacement text', () => {
    const f = fixture(
      msg('root', null),
      edit('edit-1', 'root', 'root', 'same'),
      msg('A', 'edit-1'),
    );
    appendFileSync(f.source.file, lines(edit('edit-2', 'A', 'root', 'same'), msg('B', 'edit-2')));
    const review = prepared(historicalReview(f, [checkpoint(f, 'B')]));
    expect(selections(review)).toEqual([['A', 'root', 'edit-1', 'same']]);
  });

  it('unions comparable checkpoints so later edits do not erase earlier version proof', () => {
    const f = fixture(msg('root', null), msg('A', 'root'));
    appendFileSync(f.source.file, lines(edit('edit', 'A', 'root', 'changed'), msg('B', 'edit')));
    const result = historicalReview(f, [checkpoint(f, 'A'), checkpoint(f, 'B')]);
    expect(prepared(result).evidence).toEqual([]);
    expect(prepared(result).checkpoints).toEqual([]);
  });

  it('does not mistake later removal for review of the removed version', () => {
    const f = fixture(msg('root', null), msg('A', 'root'));
    appendFileSync(f.source.file, lines(edit('remove', 'A', 'root', null), msg('B', 'remove')));
    expect(selections(prepared(historicalReview(f, [checkpoint(f, 'B')])))).toEqual([
      ['A', 'root', null, 'root'],
    ]);
  });

  it('does not treat a seed default as coverage on an unreviewed sibling', () => {
    const f = fixture(msg('root', null), msg('A', 'root'), msg('sibling', 'root'));
    f.source.seedSince = '2026-01-16T00:00:00.000Z';
    appendFileSync(f.source.file, lines(msg('B', 'A')));
    const review = prepared(historicalReview(f, [checkpoint(f, 'B', f.source.seedSince)]));
    expect(selections(review)).toEqual([
      ['sibling', 'root', null, 'root'],
      ['sibling', 'sibling', null, 'sibling'],
    ]);
  });

  it('honors finite checkpoint dates inclusively and treats unknown times as eligible', () => {
    const since = '2026-01-16T12:00:00.000Z';
    const f = fixture(
      msg('before', null, '2026-01-16T11:59:59.999Z'),
      msg('at', 'before', since),
      msg('unknown', 'at', 'not-a-date'),
      msg('A', 'unknown'),
    );
    appendFileSync(f.source.file, lines(msg('B', 'A')));
    const review = prepared(historicalReview(f, [checkpoint(f, 'B', since)]));
    expect(selections(review)).toEqual([['A', 'before', null, 'before']]);
    expect(review.checkpoints).toEqual([checkpoint(f, 'A')]);
    expect(review.warnings.map((warning) => warning.kind)).toContain('unknown-timestamp');
  });

  it('uses the edit timestamp rather than the original timestamp when mapping a seeded checkpoint', () => {
    const f = fixture(
      msg('old', null, '2020-01-01T00:00:00.000Z'),
      edit('edit', 'old', 'old', 'recent edit'),
      msg('A', 'edit'),
    );
    appendFileSync(f.source.file, lines(msg('B', 'A')));
    const result = historicalReview(f, [checkpoint(f, 'B', '2026-01-16T00:00:00.000Z')]);
    expect(result.status).toBe('already-covered');
    expect(prepared(result).evidence).toEqual([]);
  });

  it('keeps legacy NULL proof unrestricted despite a narrower seed and source default', () => {
    const f = fixture(msg('old', null, '2020-01-01T00:00:00.000Z'), msg('A', 'old'));
    f.source.seedSince = '2026-01-16T00:00:00.000Z';
    appendFileSync(f.source.file, lines(msg('B', 'A')));
    const review = prepared(
      historicalReview(f, [checkpoint(f, 'B')], { requestedSince: '2026-01-20' }),
    );
    expect(review.evidence).toEqual([]);
    expect(review.sourceDefaults).toEqual([]);
    expect(review.coverageChanged).toBe(false);
  });

  it('preserves overlapping manual seeds and subtracts only versions inside each committed window', () => {
    const f = fixture(
      msg('old', null, '2025-12-01T00:00:00.000Z'),
      msg('middle', 'old', '2026-01-10T00:00:00.000Z'),
      msg('A', 'middle'),
    );
    appendFileSync(f.source.file, lines(msg('B', 'A')));
    const store = new CheckpointStore(':memory:');
    try {
      store.enroll(f.source.sessionId, f.source.file);
      const narrow = resolveSeedSince('14d', '2026-01-30T12:00:00.000Z');
      const broad = resolveSeedSince('30d', '2026-01-30T12:00:00.000Z');
      for (const since of [narrow, broad, narrow]) {
        const manual = prepareReview(store.sources(), store.reviewed(), { requestedSince: since });
        store.finish({ checkpoints: manual.checkpoints, sourceDefaults: manual.sourceDefaults });
      }
      expect(store.reviewed()).toEqual([checkpoint(f, 'B', broad)]);
      expect(store.sources()[0]?.seedSince).toBe(broad);
      const committed = store.reviewed();
      f.source = store.sources()[0]!;
      const result = historicalReview(f, committed);
      expect(result.status).toBe('already-covered');
      expect(prepared(result).coverageChanged).toBe(false);

      // A broader, already-resolved absolute seed reveals only the older version.
      const expanded = prepared(
        historicalReview(f, committed, { requestedSince: '2025-11-01T12:00:00.000Z' }),
      );
      expect(selections(expanded)).toEqual([['A', 'old', null, 'old']]);
      expect(expanded.checkpoints).toEqual([checkpoint(f, 'A', '2025-11-01T12:00:00.000Z')]);
      expect(expanded.sourceDefaults).toEqual([
        { sessionId: f.source.sessionId, since: '2025-11-01T12:00:00.000Z' },
      ]);
      expect(store.reviewed()).toEqual(committed);
      expect(store.sources()[0]?.seedSince).toBe(broad);
    } finally {
      store.close();
    }
  });

  it('keeps the nearest local checkpoint cutoff when a descendant has a different seed', () => {
    const f = fixture(
      msg('old', null, '2025-12-01T00:00:00.000Z'),
      msg('root', 'old'),
      msg('A', 'root'),
    );
    f.source.seedSince = '2026-01-20T00:00:00.000Z';
    appendFileSync(f.source.file, lines(edit('edit', 'A', 'A', 'new A'), msg('B', 'edit')));
    const review = prepared(
      historicalReview(f, [checkpoint(f, 'root', '2026-01-01'), checkpoint(f, 'B', '2026-01-16')]),
    );
    expect(selections(review)).toEqual([['A', 'A', null, 'A']]);
    expect(review.checkpoints).toEqual([checkpoint(f, 'A', '2026-01-01T00:00:00.000Z')]);
  });

  it.each(['rewrite', 'unlink'] as const)(
    'uses preserved text after %s when every checkpoint is already in the snapshot',
    (change) => {
      const f = fixture(msg('root', null), msg('A', 'root'));
      if (change === 'rewrite') writeFileSync(f.source.file, 'rewritten');
      else rmSync(f.source.file);
      const review = prepared(historicalReview(f, [checkpoint(f, 'root')]));
      expect(selections(review)).toEqual([['A', 'A', null, 'A']]);
      expect(review.evidence[0]?.file).toBe(f.source.file);
    },
  );

  it.each([
    'rewrite',
    'unlink',
    'reformat',
    'truncated',
    'missing',
    'malformed',
    'identity',
  ] as const)(
    'retains bytes and all committed coverage, returns no plan after unmappable %s',
    (change) => {
      const f = fixture(msg('root', null), msg('A', 'root'));
      appendFileSync(f.source.file, lines(msg('B', 'A')));
      const validExtension = readFileSync(f.source.file);
      const retained = readFileSync(f.snapshotFile);
      const store = new CheckpointStore(':memory:');
      try {
        store.enroll(f.source.sessionId, f.source.file);
        store.finish([checkpoint(f, 'root'), checkpoint(f, 'B')]);
        const committed = store.reviewed();
        if (change === 'rewrite')
          writeFileSync(
            f.source.file,
            validExtension.toString().replace('"content":"A"', '"content":"X"'),
          );
        if (change === 'unlink') rmSync(f.source.file);
        if (change === 'reformat')
          writeFileSync(f.source.file, validExtension.toString().replaceAll(':', ': '));
        if (change === 'truncated')
          writeFileSync(f.source.file, retained.subarray(0, retained.length - 1));
        if (change === 'missing') writeFileSync(f.source.file, retained);
        if (change === 'malformed') appendFileSync(f.source.file, '{"type"');
        if (change === 'identity')
          writeFileSync(
            f.source.file,
            validExtension.toString().replace('historical-session', 'different-session'),
          );
        const result = historicalReview(f, committed);
        expect(result.status).toBe('blocked');
        expect(result.review).toBeNull();
        expect(result.diagnostic).toBeTruthy();
        expect(store.reviewed()).toEqual(committed);
        expect(readFileSync(f.snapshotFile)).toEqual(retained);
        // Restore the verified extension and retry the SAME retained job. No
        // checkpoint was dropped and no already-reviewed evidence is replayed.
        writeFileSync(f.source.file, validExtension);
        expect(prepared(historicalReview(f, committed)).evidence).toEqual([]);
      } finally {
        store.close();
      }
    },
  );

  it.each(['invalid date', 'unknown parent', 'duplicate entry'] as const)(
    'stops the entire scope on %s rather than publishing a partially mapped plan',
    (change) => {
      const f = fixture(msg('root', null), msg('A', 'root'));
      appendFileSync(f.source.file, lines(msg('B', 'A')));
      const boundaries = [checkpoint(f, 'root'), checkpoint(f, 'B')];
      if (change === 'invalid date') boundaries[1]!.since = 'invalid';
      if (change === 'unknown parent') appendFileSync(f.source.file, lines(msg('C', 'missing')));
      if (change === 'duplicate entry') appendFileSync(f.source.file, lines(msg('B', 'A')));
      const result = historicalReview(f, boundaries);
      expect(result.status).toBe('blocked');
      expect(result.diagnostic).toBeTruthy();
      expect(result.review).toBeNull();
      expect(boundaries.map((cp) => cp.entryId)).toEqual(['root', 'B']);
    },
  );

  it('rejects a changed snapshot identity and does not confuse another session with the same entry IDs', () => {
    const f = fixture(msg('root', null), msg('A', 'root'));
    const other = { ...checkpoint(f, 'A'), sessionId: 'other-session' };
    expect(selections(prepared(historicalReview(f, [other])))).toEqual([
      ['A', 'root', null, 'root'],
      ['A', 'A', null, 'A'],
    ]);
    f.source.sessionId = 'other-session';
    const result = historicalReview(f, [other]);
    expect(result.status).toBe('blocked');
    expect(result.diagnostic).toContain('Session identity differs');
    expect(result.review).toBeNull();
  });

  it('does not manufacture capture coverage from a seed window containing no evidence', () => {
    const f = fixture(msg('A', null, '2020-01-01T00:00:00.000Z'));
    const review = prepared(historicalReview(f, [], { requestedSince: '2026-01-16' }));
    expect(review.evidence).toEqual([]);
    expect(review.checkpoints).toEqual([]);
    expect(review.sourceDefaults).toEqual([]);
    expect(review.coverageChanged).toBe(false);
  });
});
