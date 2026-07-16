import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireWorktreeLock } from '../../extensions/session-deck/worktree/locks.js';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'session-deck-worktree-locks-'));
  tempDirectories.push(directory);
  return directory;
}

describe('session-deck worktree locks', () => {
  it('creates a missing lock root before atomically acquiring a per-key lock', async () => {
    const root = await tempDir();
    const lockRoot = join(root, 'missing', 'locks');

    expect(existsSync(lockRoot)).toBe(false);

    const first = await acquireWorktreeLock(['repo', 'branch', 'path'], { lockRoot });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      throw new Error(first.message);
    }

    const duplicate = await acquireWorktreeLock(['repo', 'branch', 'path'], { lockRoot });
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) {
      await duplicate.release();
      throw new Error('duplicate lock unexpectedly succeeded');
    }
    expect(duplicate.path).toBe(first.path);
    expect(duplicate.message).toBe('A matching worktree action is already running.');

    await first.release();
  });
});
