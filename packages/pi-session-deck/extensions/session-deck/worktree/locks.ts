import { mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface WorktreeLockOptions {
  lockRoot?: string;
}

export type WorktreeLockResult =
  | { ok: true; release: () => Promise<void>; path: string }
  | { ok: false; path: string; message: string };

export async function acquireWorktreeLock(
  keyParts: readonly string[],
  options: WorktreeLockOptions = {},
): Promise<WorktreeLockResult> {
  const lockRoot = options.lockRoot ?? join(homedir(), '.pi', 'session-deck', 'worktree-locks');
  const path = join(lockRoot, `${hashLockKey(keyParts)}.lock`);

  await mkdir(lockRoot, { recursive: true });

  try {
    await mkdir(path, { recursive: false });
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === 'EEXIST') {
      return { ok: false, path, message: 'A matching worktree action is already running.' };
    }
    throw error;
  }

  return {
    ok: true,
    path,
    release: async () => {
      await rm(path, { force: true, recursive: true });
    },
  };
}

function hashLockKey(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
}
