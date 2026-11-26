import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import {
  CaptureArtifacts,
  REMEMBRANCER_SKILL_PATH,
} from '../extensions/remembrancer/capture-artifacts.js';
import { CaptureReview } from '../extensions/remembrancer/capture-review.js';
import { prepareReview, type Evidence } from '../extensions/remembrancer/evidence.js';
import {
  REVIEW_RESPONSE_MAX_BYTES,
  splitsSurrogatePair,
} from '../extensions/remembrancer/review-pages.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    closeSync: vi.fn(actual.closeSync),
    openSync: vi.fn(actual.openSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  };
});
const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
const dirs: string[] = [];
const artifacts: CaptureArtifacts[] = [];
afterEach(() => {
  vi.mocked(readFileSync).mockReset().mockImplementation(actual.readFileSync);
  vi.mocked(unlinkSync).mockReset().mockImplementation(actual.unlinkSync);
  vi.mocked(closeSync).mockReset().mockImplementation(actual.closeSync);
  vi.mocked(openSync).mockReset().mockImplementation(actual.openSync);
  vi.mocked(writeFileSync).mockReset().mockImplementation(actual.writeFileSync);
  for (const artifact of artifacts.splice(0)) artifact.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const msg = (id: string, parentId: string | null, text = id, timestamp = '2026-01-30') => ({
  type: 'message',
  id,
  parentId,
  timestamp,
  message: { role: 'user', content: text },
});
const edit = (id: string, parentId: string, targetId: string, text: string | null) => ({
  type: 'context_edit',
  id,
  parentId,
  targetId,
  timestamp: '2026-01-30',
  replacement: text === null ? null : { content: text },
});
function fixture(records: unknown[] = [msg('entry', null, 'I will send it')]) {
  const dir = mkdtempSync(join(tmpdir(), 'capture-artifacts-test-'));
  dirs.push(dir);
  const source = { file: join(dir, 'session.jsonl'), sessionId: 'session' };
  writeFileSync(
    source.file,
    [{ type: 'session', id: source.sessionId, cwd: '/work' }, ...records]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n',
  );
  const review = prepareReview([source], []);
  let active = true;
  const current = new CaptureReview(review, () => {
    if (!active) throw new Error('Cancelled capture');
  });
  return { review, current, cancel: () => (active = false) };
}
function create(current: CaptureReview) {
  const artifact = new CaptureArtifacts(current);
  artifacts.push(artifact);
  return artifact;
}
function acceptSkill(artifact: CaptureArtifacts) {
  artifact.read(artifact.skillPath).accept();
}

type EvidenceLine = {
  groups: (Pick<Evidence, 'file' | 'sessionId' | 'cwd' | 'branchId' | 'reviewedThrough'> & {
    entries: (Pick<Evidence, 'entryId' | 'role' | 'text' | 'timestamp' | 'editId'> & {
      offset: number;
      continues: boolean;
    })[];
  })[];
};

it('exclusively creates a private evidence-only file and cleans only generated paths', () => {
  const { current } = fixture();
  const skill = actual.readFileSync(REMEMBRANCER_SKILL_PATH);
  const artifact = create(current);
  const directory = dirname(artifact.reviewPath);
  expect(artifact.skillPath).toBe(
    fileURLToPath(new URL('../skills/remembrancer/SKILL.md', import.meta.url)),
  );
  expect(readdirSync(directory)).toEqual(['review.jsonl']);
  expect(lstatSync(directory).mode & 0o777).toBe(0o700);
  expect(lstatSync(artifact.reviewPath).mode & 0o777).toBe(0o600);
  expect(vi.mocked(openSync)).toHaveBeenCalledWith(
    artifact.reviewPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  expect(actual.readFileSync(artifact.reviewPath, 'utf8')).not.toContain(skill.toString());
  artifact.dispose();
  artifact.dispose();
  expect(existsSync(directory)).toBe(false);
  expect(actual.readFileSync(artifact.skillPath)).toEqual(skill);
  expect(vi.mocked(unlinkSync).mock.calls.every(([path]) => path !== artifact.skillPath)).toBe(
    true,
  );
  expect(() => artifact.read(artifact.skillPath)).toThrow('closed');
});

it('does not acknowledge preparation, opening, or complete but unaccepted skill/evidence reads', () => {
  const { current } = fixture();
  const artifact = create(current);
  expect(() => current.completion([])).toThrow('Read all evidence');
  const skill = artifact.read(artifact.skillPath);
  expect(() => artifact.assertSkillDelivered()).toThrow('skill first');
  expect(() => artifact.read(artifact.reviewPath)).toThrow('skill first');
  skill.accept();
  const evidence = artifact.read(artifact.reviewPath);
  expect(() => artifact.assertDelivered()).toThrow('Read all evidence');
  expect(() => current.completion([])).toThrow('Read all evidence');
  evidence.accept();
  expect(() => artifact.assertDelivered()).not.toThrow();
  expect(() => current.completion([])).not.toThrow();
});

it('allows only next-page delivery or accepted-page rereads, with no coverage from context', () => {
  const { current, review } = fixture([msg('entry', null, '😀尾'.repeat(30_000))]);
  const artifact = create(current);
  acceptSkill(artifact);
  expect(artifact.pageCount).toBeGreaterThan(2);
  expect(() => artifact.read(artifact.reviewPath, 1)).toThrow('in order');
  const { sessionId, branchId, entryId, editId } = review.evidence[0]!;
  current.context({
    batch: current.id,
    selected: { sessionId, branchId, entryId, editId },
    before: 1,
  });
  expect(() => current.completion([])).toThrow('Read all evidence');
  const first = artifact.read(artifact.reviewPath);
  first.accept();
  expect(artifact.read(artifact.reviewPath).text).toBe(first.text);
  artifact.read(artifact.reviewPath).accept();
  expect(() => artifact.read(artifact.reviewPath, 2)).toThrow('in order');
  for (let page = 1; page < artifact.pageCount; page++)
    artifact.read(artifact.reviewPath, page).accept();
  expect(() => artifact.assertDelivered()).not.toThrow();
  artifact.read(artifact.reviewPath).accept();
  expect(() => current.completion([])).not.toThrow();
});

it('preserves original order, branches, equal-text edits, redactions and absolute Unicode coordinates', () => {
  const text = 'a😀𐐷é\n🛠️尾\u0000"'.repeat(8_000);
  const { current, review } = fixture([
    msg('root', null, text, '2026-02-02'),
    edit('edit-a', 'root', 'root', text),
    msg('a1', 'edit-a', 'first', '2026-01-01'),
    msg('a2', 'edit-a'),
    edit('edit-b', 'root', 'root', text),
    msg('b', 'edit-b'),
    msg('original', 'root'),
    edit('redact', 'root', 'root', null),
    msg('redacted-child', 'redact'),
  ]);
  const original = structuredClone(review.evidence);
  review.evidence.length = 0;
  const artifact = create(current);
  const lines = actual.readFileSync(artifact.reviewPath, 'utf8').trimEnd().split('\n');
  expect(lines.length).toBe(artifact.pageCount);
  let index = 0;
  let offset = 0;
  const edits: (string | null)[] = [];
  for (const line of lines) {
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(REVIEW_RESPONSE_MAX_BYTES);
    const page = JSON.parse(line) as EvidenceLine;
    for (const { entries, ...group } of page.groups) {
      for (const entry of entries) {
        const item = original[index]!;
        expect({ ...group, ...entry }).toEqual({
          ...item,
          text: item.text.slice(offset, offset + entry.text.length),
          offset,
          continues: offset + entry.text.length < item.text.length,
        });
        expect(splitsSurrogatePair(item.text, offset)).toBe(false);
        offset += entry.text.length;
        expect(splitsSurrogatePair(item.text, offset)).toBe(false);
        if (!entry.continues) {
          if (entry.entryId === 'root') edits.push(entry.editId);
          expect(offset).toBe(item.text.length);
          index++;
          offset = 0;
        }
      }
    }
  }
  expect(index).toBe(original.length);
  expect(edits).toEqual(['edit-a', 'edit-a', 'edit-b', null]);
  expect(
    original.filter((item) => item.branchId === 'redacted-child').map((item) => item.entryId),
  ).toEqual(['redacted-child']);
  expect(() => current.completion([])).toThrow('Read all evidence');
});

it('confines reads to literal allowlisted paths and valid complete pages', () => {
  const { current } = fixture();
  const artifact = create(current);
  for (const path of [
    dirname(artifact.reviewPath),
    join(dirname(artifact.skillPath), 'other.md'),
    artifact.reviewPath.replace('/review.jsonl', '/./review.jsonl'),
    artifact.skillPath.replace('/SKILL.md', '/./SKILL.md'),
    '/etc/passwd',
  ])
    expect(() => artifact.read(path)).toThrow('not an allowed');
  expect(() => artifact.read(artifact.skillPath, 1)).toThrow('complete installed skill');
  acceptSkill(artifact);
  for (const page of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, artifact.pageCount])
    expect(() => artifact.read(artifact.reviewPath, page)).toThrow('Invalid capture');
  expect(() => current.completion([])).toThrow('Read all evidence');
});

it.each(['ENOENT', 'EACCES'])(
  'fails startup and later reads when the installed skill is %s',
  (code) => {
    const { current } = fixture();
    const error = Object.assign(new Error(`skill ${code}`), { code });
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw error;
    });
    expect(() => new CaptureArtifacts(current)).toThrow(`skill ${code}`);
    const artifact = create(current);
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw error;
    });
    expect(() => artifact.read(artifact.skillPath)).toThrow(`skill ${code}`);
    expect(() => artifact.assertDelivered()).toThrow('skill first');
    expect(() => current.completion([])).toThrow('Read all evidence');
  },
);

it('fails delivery completion if the previously delivered installed skill becomes unreadable', () => {
  const { current } = fixture();
  const artifact = create(current);
  acceptSkill(artifact);
  artifact.read(artifact.reviewPath).accept();
  vi.mocked(readFileSync).mockImplementationOnce(() => {
    throw new Error('skill unreadable');
  });
  expect(() => artifact.assertDelivered()).toThrow('skill unreadable');
});

it.each(['open', 'write'])(
  'cleans partial preparation without acknowledging a failed %s',
  (operation) => {
    const { current } = fixture();
    vi.mocked(closeSync).mockClear();
    if (operation === 'open')
      vi.mocked(openSync).mockImplementationOnce(() => {
        throw new Error('open failed');
      });
    else
      vi.mocked(writeFileSync).mockImplementationOnce(() => {
        throw new Error('write failed');
      });
    expect(() => new CaptureArtifacts(current)).toThrow(`${operation} failed`);
    const generatedPath = vi.mocked(openSync).mock.calls.at(-1)![0] as string;
    expect(existsSync(dirname(generatedPath))).toBe(false);
    expect(vi.mocked(closeSync)).toHaveBeenCalledTimes(operation === 'write' ? 1 : 0);
    expect(() => current.completion([])).toThrow('Read all evidence');
  },
);

it('fails oversized evidence metadata preparation without accepting any evidence', () => {
  const { review } = fixture();
  review.evidence[0]!.cwd = 'x'.repeat(REVIEW_RESPONSE_MAX_BYTES);
  const current = new CaptureReview(review, () => {});
  vi.mocked(openSync).mockClear();
  expect(() => new CaptureArtifacts(current)).toThrow('metadata or envelope cannot fit');
  expect(vi.mocked(openSync)).not.toHaveBeenCalled();
  expect(() => current.completion([])).toThrow('Read all evidence');
});

it('reads installed guidance directly each time without freezing or generated-file integrity checks', () => {
  const { current } = fixture();
  const artifact = create(current);
  vi.mocked(readFileSync).mockReturnValueOnce('first installed guidance');
  const first = artifact.read(artifact.skillPath);
  vi.mocked(readFileSync).mockReturnValueOnce('updated installed guidance');
  expect(artifact.read(artifact.skillPath).text).toBe('updated installed guidance');
  first.accept();
  expect(() => artifact.assertSkillDelivered()).not.toThrow();
});

it.each(['same-length bytes', 'truncation', 'append', 'replacement', 'symlink'])(
  'rejects generated-file %s without acknowledging delivery',
  (kind) => {
    const { current } = fixture();
    const artifact = create(current);
    acceptSkill(artifact);
    const pending = artifact.read(artifact.reviewPath);
    const original = actual.readFileSync(artifact.reviewPath);
    if (kind === 'same-length bytes') {
      const changed = Buffer.from(original);
      changed[changed.indexOf('I will send it')] = 'X'.charCodeAt(0);
      writeFileSync(artifact.reviewPath, changed);
    } else if (kind === 'truncation') writeFileSync(artifact.reviewPath, '');
    else if (kind === 'append') appendFileSync(artifact.reviewPath, ' ');
    else {
      const moved = join(dirname(artifact.reviewPath), 'retained.jsonl');
      renameSync(artifact.reviewPath, moved);
      if (kind === 'replacement') writeFileSync(artifact.reviewPath, original);
      else symlinkSync(artifact.skillPath, artifact.reviewPath);
      // The test moved this file, so the test owns its extra path's cleanup.
      dirs.push(dirname(artifact.reviewPath));
      unlinkSync(moved);
    }
    expect(() => artifact.read(artifact.reviewPath)).toThrow('changed');
    expect(() => pending.accept()).toThrow('changed');
    expect(() => current.completion([])).toThrow('Read all evidence');
  },
);

it.each(['close', 'unlink'])('attempts all generated cleanup even when %s fails', (operation) => {
  const { current } = fixture();
  const artifact = create(current);
  const directory = dirname(artifact.reviewPath);
  vi.mocked(closeSync).mockClear();
  if (operation === 'unlink')
    vi.mocked(unlinkSync).mockImplementationOnce(() => {
      throw new Error('unlink failed');
    });
  else
    vi.mocked(closeSync).mockImplementationOnce(() => {
      throw new Error('close failed');
    });
  expect(() => artifact.dispose()).toThrow('cleanup failed');
  expect(vi.mocked(closeSync)).toHaveBeenCalledOnce();
  expect(existsSync(artifact.reviewPath)).toBe(operation === 'unlink');
  expect(() => artifact.read(artifact.reviewPath)).toThrow('closed');
  artifact.dispose();
  expect(existsSync(directory)).toBe(false);
});

it('accepts empty evidence only after full skill delivery and rejects late cancellation', () => {
  const empty = fixture([]);
  const artifact = create(empty.current);
  expect(() => artifact.assertDelivered()).toThrow('skill first');
  acceptSkill(artifact);
  expect(() => artifact.assertDelivered()).toThrow('Read all evidence');
  artifact.read(artifact.reviewPath).accept();
  expect(() => artifact.assertDelivered()).not.toThrow();
  const { current, cancel } = fixture();
  const cancelled = create(current);
  acceptSkill(cancelled);
  const pending = cancelled.read(cancelled.reviewPath);
  cancel();
  expect(() => pending.accept()).toThrow('Cancelled');
  expect(() => cancelled.assertDelivered()).toThrow('Cancelled');
});
