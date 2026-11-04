import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type BoardInstallResult =
  | { ok: true; status: 'board-installed'; path: string }
  | { ok: true; status: 'board-updated'; path: string }
  | { ok: true; status: 'board-current'; path: string; warning?: string }
  | {
      ok: false;
      status: 'board-install-failed' | 'board-install-partial';
      path: string;
      message: string;
    };

const PACKAGE = '@robhowley/pi-cmux-junction';
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const detail = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const hasCode = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

async function inspect(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw new Error(`Inspect ${path}: ${detail(error)}`);
  }
}

async function parents(home: string, create = false): Promise<void> {
  let path = home;
  for (const part of ['.config', 'cmux', 'sidebars']) {
    path = join(path, part);
    let stat = await inspect(path);
    if (!stat && create) {
      try {
        await mkdir(path);
      } catch (error) {
        if (!hasCode(error, 'EEXIST'))
          throw new Error(`Create directory ${path}: ${detail(error)}`);
      }
      stat = await inspect(path);
    }
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe directory: ${path}`);
  }
}

type Snapshot = { stat: Stats; bytes: Buffer };
function same(a: Snapshot | undefined, b: Snapshot | undefined): boolean {
  return a === undefined || b === undefined
    ? a === b
    : a.stat.dev === b.stat.dev && a.stat.ino === b.stat.ino && a.bytes.equals(b.bytes);
}

async function readRegular(path: string, limit?: number): Promise<Snapshot | undefined> {
  const stat = await inspect(path);
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe regular file: ${path}`);
  let handle: FileHandle | undefined;
  let failure: unknown;
  let snapshot: Snapshot | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
      throw new Error('file identity changed');
    // A bounded read makes oversized receipts malformed, not an unbounded allocation.
    let bytes: Buffer;
    if (limit === undefined) bytes = await handle.readFile();
    else {
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await handle.read(buffer, length, buffer.length - length, length);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      bytes = buffer.subarray(0, length);
    }
    snapshot = { stat: opened, bytes };
  } catch (error) {
    failure = error;
  }
  try {
    await handle?.close();
  } catch (error) {
    failure = new Error(
      `${failure === undefined ? '' : `${detail(failure)}; `}close: ${detail(error)}`,
    );
  }
  if (failure !== undefined) throw new Error(`Read ${path}: ${detail(failure)}`);
  return snapshot;
}

function receiptHash(snapshot: Snapshot | undefined): string | undefined {
  if (!snapshot || snapshot.bytes.length > 1024) return undefined;
  try {
    const value: unknown = JSON.parse(snapshot.bytes.toString('utf8'));
    if (
      typeof value !== 'object' ||
      value === null ||
      Object.keys(value).length !== 3 ||
      !('version' in value) ||
      value.version !== 1 ||
      !('package' in value) ||
      value.package !== PACKAGE ||
      !('sha256' in value) ||
      typeof value.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.sha256)
    )
      return undefined;
    return value.sha256;
  } catch {
    return undefined;
  }
}

export async function installJunctionBoard(
  options: { homeDir?: string } = {},
): Promise<BoardInstallResult> {
  const home = resolve(options.homeDir ?? homedir());
  const directory = join(home, '.config/cmux/sidebars');
  const path = join(directory, 'junction-board.swift');
  const receiptPath = join(directory, '.pi-cmux-junction-board.receipt');
  const lockPath = join(directory, '.pi-cmux-junction-board.lock');
  const jsonPath = join(directory, 'junction-board.json');
  const temps = new Map<string, FileHandle>();
  let lock: FileHandle | undefined;
  let published = false;
  let receiptPublished = false;
  let action = `Read packaged board ${new URL('./sidebar/junction-board.swift', import.meta.url).pathname}`;
  let result: BoardInstallResult | undefined;

  async function stage(bytes: Buffer, mode: number): Promise<string> {
    const temp = join(directory, `.pi-cmux-junction-board.${randomUUID()}.tmp`);
    action = `Stage ${temp}`;
    const handle = await open(temp, 'wx', mode);
    temps.set(temp, handle);
    await handle.writeFile(bytes);
    await handle.close();
    return temp;
  }

  try {
    const bytes = await readFile(new URL('./sidebar/junction-board.swift', import.meta.url));
    action = `Prepare sidebar directory ${directory}`;
    await parents(home, true);
    action = `Acquire lock ${lockPath}`;
    try {
      lock = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
      const existing = await inspect(lockPath);
      throw new Error(
        existing?.isFile() && !existing.isSymbolicLink()
          ? 'Installer busy; existing lock left untouched'
          : 'Unsafe lock',
      );
    }
    action = `Inspect board and receipt in ${directory}`;
    await parents(home);
    const board = await readRegular(path);
    const receipt = await readRegular(receiptPath, 1024);
    const hash = receiptHash(receipt);
    if (board?.bytes.equals(bytes)) {
      result = {
        ok: true,
        status: 'board-current',
        path,
        ...(hash === digest(bytes)
          ? {}
          : {
              warning:
                'No valid matching receipt; automatic future updates are unavailable. Receipt left unchanged.',
            }),
      };
    } else {
      if (board ? hash !== digest(board.bytes) : receipt !== undefined && hash === undefined) {
        throw new Error(`Refusing unowned or modified board/receipt: ${path}; ${receiptPath}`);
      }
      if (!board && (await inspect(jsonPath))) throw new Error(`Refusing to shadow ${jsonPath}`);
      const temp = await stage(bytes, 0o644);
      action = `Recheck board publication ${path}`;
      await parents(home);
      if (board) {
        if (
          !same(receipt, await readRegular(receiptPath, 1024)) ||
          !same(board, await readRegular(path))
        )
          throw new Error('Board or receipt changed before update');
        action = `Publish updated board ${path}`;
        // Recheck + rename is cooperative safety, not compare-and-swap against external editors.
        await rename(temp, path);
        temps.delete(temp);
      } else {
        if (await inspect(jsonPath)) throw new Error(`Refusing to shadow ${jsonPath}`);
        action = `Publish missing board ${path}`;
        await link(temp, path);
      }
      published = true;
      action = `Read back published board ${path}`;
      if (!(await readRegular(path))?.bytes.equals(bytes))
        throw new Error('Published board readback differs');
      const receiptTemp = await stage(
        Buffer.from(JSON.stringify({ version: 1, package: PACKAGE, sha256: digest(bytes) }) + '\n'),
        0o600,
      );
      await parents(home);
      if (!same(receipt, await readRegular(receiptPath, 1024)))
        throw new Error(`Receipt changed: ${receiptPath}`);
      action = `Publish receipt ${receiptPath}`;
      if (receipt) {
        await rename(receiptTemp, receiptPath);
        temps.delete(receiptTemp);
      } else await link(receiptTemp, receiptPath);
      receiptPublished = true;
      result = { ok: true, status: board ? 'board-updated' : 'board-installed', path };
    }
  } catch (error) {
    result = {
      ok: false,
      status: published ? 'board-install-partial' : 'board-install-failed',
      path,
      message: `${published ? 'Board published; receipt not completed.' : 'Board not published by this invocation.'} ${action}: ${detail(error)}`,
    };
  } finally {
    const cleanup: string[] = [];
    for (const [temp, handle] of temps) {
      try {
        await handle.close();
      } catch (error) {
        cleanup.push(`Close ${temp}: ${detail(error)}`);
      }
      try {
        await unlink(temp);
      } catch (error) {
        cleanup.push(`Remove owned temp ${temp}: ${detail(error)}`);
      }
    }
    if (lock) {
      try {
        const owned = await lock.stat();
        const current = await inspect(lockPath);
        if (!current?.isFile() || current.dev !== owned.dev || current.ino !== owned.ino) {
          cleanup.push(`Release lock ${lockPath}: lock identity changed; left untouched`);
        } else {
          await unlink(lockPath);
        }
      } catch (error) {
        cleanup.push(`Release lock ${lockPath}: ${detail(error)}`);
      }
      try {
        await lock.close();
      } catch (error) {
        cleanup.push(`Close lock ${lockPath}: ${detail(error)}`);
      }
    }
    if (cleanup.length) {
      result = {
        ok: false,
        status: published ? 'board-install-partial' : 'board-install-failed',
        path,
        message: `${published ? `Board published; receipt ${receiptPublished ? 'published' : 'not completed'}.` : 'Board not published by this invocation.'} ${result && !result.ok ? result.message : ''} Cleanup failed: ${cleanup.join('; ')}`,
      };
    }
  }
  return result!;
}
