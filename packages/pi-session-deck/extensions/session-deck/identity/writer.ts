import { mkdir, rename, writeFile } from 'node:fs/promises';
import { normalizeSessionRuntimeSignalsMetadata, normalizeSessionTerminalMetadata } from './metadata.js';
import {
  createIdentityTempPath,
  getDefaultIdentityDirectory,
  getIdentityRecordPath,
} from './store.js';
import type { SessionIdentityRecord } from './types.js';

export interface WriteIdentityRecordOptions {
  directory?: string;
  createTempPath?: (runtimeId: string, directory: string) => string;
  mkdir?: typeof mkdir;
  writeFile?: typeof writeFile;
  rename?: typeof rename;
}

export function serializeIdentityRecord(record: SessionIdentityRecord): string {
  const { runtimeSignals: rawRuntimeSignals, terminal: rawTerminal, ...baseRecord } = record;
  const terminal = normalizeSessionTerminalMetadata(rawTerminal);
  const runtimeSignals = normalizeSessionRuntimeSignalsMetadata(rawRuntimeSignals);
  const serializableRecord = {
    ...baseRecord,
    ...(terminal === undefined ? {} : { terminal }),
    ...(runtimeSignals === undefined ? {} : { runtimeSignals }),
  };

  return `${JSON.stringify(serializableRecord, null, 2)}\n`;
}

export async function writeIdentityRecord(
  record: SessionIdentityRecord,
  options: WriteIdentityRecordOptions = {},
): Promise<string> {
  const directory = options.directory ?? getDefaultIdentityDirectory();
  const mkdirImpl = options.mkdir ?? mkdir;
  const writeFileImpl = options.writeFile ?? writeFile;
  const renameImpl = options.rename ?? rename;
  const createTempPath = options.createTempPath ?? createIdentityTempPath;

  await mkdirImpl(directory, { recursive: true });

  const targetPath = getIdentityRecordPath(record.runtimeId, directory);
  const tempPath = createTempPath(record.runtimeId, directory);
  await writeFileImpl(tempPath, serializeIdentityRecord(record), 'utf8');
  await renameImpl(tempPath, targetPath);

  return targetPath;
}
