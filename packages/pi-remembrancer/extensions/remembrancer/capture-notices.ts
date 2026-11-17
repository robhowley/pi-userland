import { randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CheckpointStore } from './checkpoints.js';

export type ProposalNotice = { generation: number; pending: number };

/** Derived only from committed SQLite state. The singleton worker serializes replacement. */
export async function publishProposalNotice(store: CheckpointStore): Promise<void> {
  const notice = store.proposalNotice();
  const target = store.file + '.notice.json';
  const temporary = target + '.' + randomUUID() + '.tmp';
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(notice) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, target);
    const directory = await open(dirname(target), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/** No SQLite descriptors or synchronous filesystem work on the TUI tick. */
export async function readProposalNotice(database: string): Promise<ProposalNotice | undefined> {
  try {
    const value = JSON.parse(await readFile(database + '.notice.json', 'utf8')) as ProposalNotice;
    if (
      !Number.isSafeInteger(value.generation) ||
      value.generation < 0 ||
      !Number.isSafeInteger(value.pending) ||
      value.pending < 0
    )
      throw Error('Invalid proposal notice');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
