import { mkdir, rename, writeFile } from 'node:fs/promises';
import {
  createActivityTempPath,
  getActivityRecordPath,
  getDefaultActivityDirectory,
} from './store.js';
import type { SessionActivityRecord } from './types.js';

export interface WriteActivityRecordOptions {
  directory?: string;
  createTempPath?: (runtimeId: string, directory: string) => string;
  mkdir?: typeof mkdir;
  writeFile?: typeof writeFile;
  rename?: typeof rename;
}

export function serializeActivityRecord(record: SessionActivityRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export async function writeActivityRecord(
  record: SessionActivityRecord,
  options: WriteActivityRecordOptions = {},
): Promise<string> {
  const directory = options.directory ?? getDefaultActivityDirectory();
  const mkdirImpl = options.mkdir ?? mkdir;
  const writeFileImpl = options.writeFile ?? writeFile;
  const renameImpl = options.rename ?? rename;
  const createTempPath = options.createTempPath ?? createActivityTempPath;

  await mkdirImpl(directory, { recursive: true });

  const targetPath = getActivityRecordPath(record.runtimeId, directory);
  const tempPath = createTempPath(record.runtimeId, directory);
  await writeFileImpl(tempPath, serializeActivityRecord(record), 'utf8');
  await renameImpl(tempPath, targetPath);

  return targetPath;
}
