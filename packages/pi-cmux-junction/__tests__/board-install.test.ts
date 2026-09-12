import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installJunctionBoard } from '../extensions/cmux-junction/board-install.js';

vi.mock('node:fs/promises', async (original) => ({ ...(await original<typeof fs>()) }));
const source = new URL('../extensions/cmux-junction/sidebar/junction-board.swift', import.meta.url);
const bytes = await fs.readFile(source);
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const receipt = (value: Buffer) =>
  JSON.stringify({ version: 1, package: '@robhowley/pi-cmux-junction', sha256: hash(value) });
let home: string;
let directory: string;
let board: string;
let record: string;
let lock: string;
beforeEach(async () => {
  home = await fs.mkdtemp(join(tmpdir(), 'junction-install-'));
  directory = join(home, '.config/cmux/sidebars');
  board = join(directory, 'junction-board.swift');
  record = join(directory, '.pi-cmux-junction-board.receipt');
  lock = join(directory, '.pi-cmux-junction-board.lock');
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});
async function setup(value?: Buffer, metadata?: string) {
  await fs.mkdir(directory, { recursive: true });
  if (value) await fs.writeFile(board, value);
  if (metadata !== undefined) await fs.writeFile(record, metadata);
}
const install = () => installJunctionBoard({ homeDir: home });
async function clean() {
  expect(
    (await fs.readdir(directory)).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock')),
  ).toEqual([]);
}
function release(value: Buffer) {
  const read = fs.readFile;
  vi.spyOn(fs, 'readFile').mockImplementation((...args) =>
    args[0] instanceof URL ? Promise.resolve(Buffer.from(value)) : read(...args),
  );
}

describe('file-only board installation', () => {
  it('copies exact bundled controls and receipt, preserving unrelated files and ignoring XDG', async () => {
    await setup();
    vi.stubEnv('XDG_CONFIG_HOME', join(home, 'xdg'));
    for (const name of ['status-board.swift', 'other.json', '../settings.json'])
      await fs.writeFile(join(directory, name), 'sentinel');
    expect(await install()).toEqual({ ok: true, status: 'board-installed', path: board });
    expect(await fs.readFile(board)).toEqual(bytes);
    expect(bytes.includes(Buffer.from('\r\n'))).toBe(true);
    expect(JSON.parse(await fs.readFile(record, 'utf8'))).toEqual(JSON.parse(receipt(bytes)));
    for (const name of ['status-board.swift', 'other.json', '../settings.json'])
      expect(await fs.readFile(join(directory, name), 'utf8')).toBe('sentinel');
    await clean();
  });

  it.each(['matching', 'missing', 'malformed', 'mismatched', 'oversized'])(
    'current bytes are never adopted or repaired: %s',
    async (kind) => {
      const metadata =
        kind === 'matching'
          ? receipt(bytes)
          : kind === 'missing'
            ? undefined
            : kind === 'mismatched'
              ? receipt(Buffer.from('old'))
              : kind === 'oversized'
                ? 'x'.repeat(1025)
                : '{bad';
      await setup(bytes, metadata);
      const before = await fs.stat(board);
      const recordBefore = metadata === undefined ? undefined : await fs.stat(record);
      const result = await install();
      expect(result).toMatchObject({ ok: true, status: 'board-current' });
      expect('warning' in result).toBe(kind !== 'matching');
      expect(await fs.stat(board)).toMatchObject({ ino: before.ino, mtimeMs: before.mtimeMs });
      expect(await fs.readFile(board)).toEqual(bytes);
      if (metadata === undefined)
        await expect(fs.lstat(record)).rejects.toMatchObject({ code: 'ENOENT' });
      else {
        expect(await fs.stat(record)).toMatchObject({
          ino: recordBefore!.ino,
          mtimeMs: recordBefore!.mtimeMs,
        });
        expect(await fs.readFile(record, 'utf8')).toBe(metadata);
      }
      if (kind !== 'matching') {
        release(Buffer.from('later release'));
        expect(await install()).toMatchObject({ status: 'board-install-failed' });
      }
      await clean();
    },
  );

  it('updates receipt-owned old bytes, even with same-name JSON present', async () => {
    const old = Buffer.from('old\r\n\u0000');
    await setup(old, receipt(old));
    await fs.writeFile(join(directory, 'junction-board.json'), 'keep');
    expect(await install()).toMatchObject({ status: 'board-updated' });
    expect(await fs.readFile(board)).toEqual(bytes);
    expect(JSON.parse(await fs.readFile(record, 'utf8')).sha256).toBe(hash(bytes));
    expect(await fs.readFile(join(directory, 'junction-board.json'), 'utf8')).toBe('keep');
    await clean();
  });

  it.each([
    undefined,
    '{bad',
    '{"version":2}',
    JSON.stringify({ version: 1, package: 'foreign', sha256: 'a'.repeat(64) }),
    receipt(Buffer.from('other')),
  ])('refuses different unowned bytes with receipt %j', async (metadata) => {
    const old = Buffer.from('user edit');
    await setup(old, metadata);
    expect(await install()).toMatchObject({ status: 'board-install-failed' });
    expect(await fs.readFile(board)).toEqual(old);
    if (metadata !== undefined) expect(await fs.readFile(record, 'utf8')).toBe(metadata);
    await clean();
  });

  it.each([
    'board-live',
    'board-dangling',
    'board-directory',
    'receipt',
    'lock',
    '.config',
    'cmux',
    'sidebars',
  ])('refuses unsafe object %s', async (kind) => {
    await setup();
    const target = join(home, 'target');
    await fs.writeFile(target, bytes);
    if (kind === 'board-directory') await fs.mkdir(board);
    else if (['.config', 'cmux', 'sidebars'].includes(kind)) {
      const parent =
        kind === '.config'
          ? join(home, '.config')
          : kind === 'cmux'
            ? join(home, '.config/cmux')
            : directory;
      await fs.rm(parent, { recursive: true });
      const other = join(home, 'other');
      await fs.mkdir(other);
      await fs.symlink(other, parent);
    } else
      await fs.symlink(
        kind === 'board-dangling' ? join(home, 'absent') : target,
        kind === 'receipt' ? record : kind === 'lock' ? lock : board,
      );
    expect(await install()).toMatchObject({ status: 'board-install-failed' });
    expect(await fs.readFile(target)).toEqual(bytes);
  });

  it('leaves existing lock busy and untouched', async () => {
    await setup();
    await fs.writeFile(lock, 'stale or busy');
    expect(await install()).toMatchObject({
      status: 'board-install-failed',
      message: expect.stringContaining('busy'),
    });
    expect(await fs.readFile(lock, 'utf8')).toBe('stale or busy');
  });
  it('refuses dangling JSON collision but ignores it for current Swift', async () => {
    await setup();
    await fs.symlink(join(home, 'absent'), join(directory, 'junction-board.json'));
    expect(await install()).toMatchObject({ status: 'board-install-failed' });
    await fs.writeFile(board, bytes);
    expect(await install()).toMatchObject({ status: 'board-current' });
  });
  it('refuses malformed metadata even when Swift is absent', async () => {
    await setup(undefined, '{}');
    expect(await install()).toMatchObject({ status: 'board-install-failed' });
  });
  it('advances valid stale metadata on fresh install', async () => {
    await setup(undefined, receipt(Buffer.from('old')));
    expect(await install()).toMatchObject({ status: 'board-installed' });
  });
  it('preserves a destination arriving at the no-replace publication', async () => {
    const link = fs.link;
    vi.spyOn(fs, 'link').mockImplementation(async (temp, destination) => {
      if (destination === board) {
        expect(await fs.readFile(temp)).toEqual(bytes);
        await fs.writeFile(board, 'arrival');
      }
      return link(temp, destination);
    });
    expect(await install()).toMatchObject({ status: 'board-install-failed' });
    expect(await fs.readFile(board, 'utf8')).toBe('arrival');
    await clean();
  });
  it('detects an edit before the final update recheck', async () => {
    const old = Buffer.from('old');
    await setup(old, receipt(old));
    const open = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('.tmp')) await fs.writeFile(board, 'edit');
      return open(...args);
    });
    expect(await install()).toMatchObject({ status: 'board-install-failed' });
    expect(await fs.readFile(board, 'utf8')).toBe('edit');
    expect(await fs.readFile(record, 'utf8')).toBe(receipt(old));
    await clean();
  });
  it('cleans an owned temp after an incomplete staging write', async () => {
    const open = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).endsWith('.tmp')) {
        vi.spyOn(handle, 'writeFile').mockRejectedValue(new Error('write fault'));
      }
      return handle;
    });
    expect(await install()).toMatchObject({
      status: 'board-install-failed',
      message: expect.stringContaining('write fault'),
    });
    await expect(fs.lstat(board)).rejects.toMatchObject({ code: 'ENOENT' });
    await clean();
  });
  it('does not replace a receipt arriving after board publication', async () => {
    const link = fs.link;
    vi.spyOn(fs, 'link').mockImplementation(async (temp, target) => {
      if (target === record) await fs.writeFile(record, 'foreign arrival');
      return link(temp, target);
    });
    expect(await install()).toMatchObject({ status: 'board-install-partial' });
    expect(await fs.readFile(board)).toEqual(bytes);
    expect(await fs.readFile(record, 'utf8')).toBe('foreign arrival');
    await clean();
  });
  it('does not advance a previous receipt when board readback differs', async () => {
    const old = Buffer.from('old');
    await setup(old, receipt(old));
    const rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation(async (temp, target) => {
      await rename(temp, target);
      if (target === board) await fs.writeFile(board, 'external edit after publication');
    });
    expect(await install()).toMatchObject({
      status: 'board-install-partial',
      message: expect.stringContaining('readback differs'),
    });
    expect(await fs.readFile(record, 'utf8')).toBe(receipt(old));
    await clean();
  });
  it('reports owned-temp cleanup failure even after both publications', async () => {
    const unlink = fs.unlink;
    vi.spyOn(fs, 'unlink').mockImplementation((path) =>
      String(path).endsWith('.tmp')
        ? Promise.reject(new Error('temp cleanup fault'))
        : unlink(path),
    );
    expect(await install()).toMatchObject({
      status: 'board-install-partial',
      message: expect.stringContaining('receipt published'),
    });
    expect(await fs.readFile(board)).toEqual(bytes);
    const leftovers = (await fs.readdir(directory)).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toHaveLength(2);
    expect(leftovers.every((name) => !name.endsWith('.swift') && !name.endsWith('.json'))).toBe(
      true,
    );
    await expect(fs.lstat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('source failure precedes all directory mutation', async () => {
    vi.spyOn(fs, 'readFile').mockRejectedValue(new Error('source unavailable'));
    expect(await install()).toMatchObject({
      status: 'board-install-failed',
      message: expect.stringContaining('source unavailable'),
    });
    expect(await fs.readdir(home)).toEqual([]);
  });
  it.each(['inspect', 'open', 'read'])(
    'receipt %s I/O error fails even for current bytes',
    async (operation) => {
      await setup(bytes, receipt(bytes));
      const open = fs.open;
      const lstat = fs.lstat;
      if (operation === 'inspect')
        vi.spyOn(fs, 'lstat').mockImplementation((...args) =>
          args[0] === record ? Promise.reject(new Error('EACCES inspect')) : lstat(...args),
        );
      else
        vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
          if (args[0] !== record) return open(...args);
          if (operation === 'open') throw new Error('EACCES open');
          const handle = await open(...args);
          vi.spyOn(handle, 'read').mockRejectedValue(new Error('EACCES read'));
          return handle;
        });
      expect(await install()).toMatchObject({
        status: 'board-install-failed',
        message: expect.stringContaining('EACCES'),
      });
      expect(await fs.readFile(board)).toEqual(bytes);
      await clean();
    },
  );
  it.each(['stage', 'board', 'receipt'])('classifies %s publication failure', async (stage) => {
    const open = fs.open;
    const link = fs.link;
    if (stage === 'stage')
      vi.spyOn(fs, 'open').mockImplementation((...args) =>
        String(args[0]).endsWith('.tmp') ? Promise.reject(new Error('stage fault')) : open(...args),
      );
    else
      vi.spyOn(fs, 'link').mockImplementation((temp, target) =>
        target === (stage === 'board' ? board : record)
          ? Promise.reject(new Error('publish fault'))
          : link(temp, target),
      );
    expect(await install()).toMatchObject({
      status: stage === 'receipt' ? 'board-install-partial' : 'board-install-failed',
    });
    if (stage === 'receipt') {
      expect(await fs.readFile(board)).toEqual(bytes);
      release(Buffer.from('next release'));
      expect(await install()).toMatchObject({ status: 'board-install-failed' });
    } else await expect(fs.lstat(board)).rejects.toMatchObject({ code: 'ENOENT' });
    await clean();
  });
  it.each(['current', 'refusal', 'published'])(
    'classifies cleanup failure after %s and retains primary error',
    async (stage) => {
      if (stage !== 'published') await setup(stage === 'current' ? bytes : Buffer.from('foreign'));
      const unlink = fs.unlink;
      vi.spyOn(fs, 'unlink').mockImplementation((path) =>
        path === lock ? Promise.reject(new Error('cleanup fault')) : unlink(path),
      );
      const result = await install();
      expect(result).toMatchObject({
        status: stage === 'published' ? 'board-install-partial' : 'board-install-failed',
        message: expect.stringContaining('cleanup fault'),
      });
      if (stage === 'refusal')
        expect(result).toMatchObject({ message: expect.stringContaining('Refusing unowned') });
      expect(await fs.lstat(lock)).toBeDefined();
    },
  );
});
