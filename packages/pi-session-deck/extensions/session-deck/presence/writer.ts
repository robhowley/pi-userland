import { mkdir, rename, writeFile } from 'node:fs/promises';
import {
  createPresenceTempPath,
  getDefaultPresenceDirectory,
  getPresenceRecordPath,
} from './store.js';
import type { PresenceRecord } from './types.js';

export interface WritePresenceRecordOptions {
  directory?: string;
  createTempPath?: (runtimeId: string, directory: string) => string;
  mkdir?: typeof mkdir;
  writeFile?: typeof writeFile;
  rename?: typeof rename;
}

export function serializePresenceRecord(record: PresenceRecord): string {
  return `${JSON.stringify(
    {
      runtimeId: record.runtimeId,
      pid: record.pid,
      startedAt: record.startedAt,
      heartbeatAt: record.heartbeatAt,
    },
    null,
    2,
  )}\n`;
}

export async function writePresenceRecord(
  record: PresenceRecord,
  options: WritePresenceRecordOptions = {},
): Promise<string> {
  const directory = options.directory ?? getDefaultPresenceDirectory();
  const mkdirImpl = options.mkdir ?? mkdir;
  const writeFileImpl = options.writeFile ?? writeFile;
  const renameImpl = options.rename ?? rename;
  const createTempPath = options.createTempPath ?? createPresenceTempPath;

  await mkdirImpl(directory, { recursive: true });

  const targetPath = getPresenceRecordPath(record.runtimeId, directory);
  const tempPath = createTempPath(record.runtimeId, directory);
  await writeFileImpl(tempPath, serializePresenceRecord(record), 'utf8');
  await renameImpl(tempPath, targetPath);

  return targetPath;
}
