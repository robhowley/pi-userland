import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { IDENTITY_PATH_SEGMENTS } from './constants.js';

export function getDefaultIdentityDirectory(homeDirectory = homedir()): string {
  return join(homeDirectory, ...IDENTITY_PATH_SEGMENTS);
}

export function getIdentityRecordPath(
  runtimeId: string,
  directory = getDefaultIdentityDirectory(),
): string {
  return join(directory, `${runtimeId}.json`);
}

export function createIdentityTempPath(
  runtimeId: string,
  directory = getDefaultIdentityDirectory(),
  tempId = randomUUID(),
): string {
  return join(directory, `.${runtimeId}.${tempId}.tmp`);
}

export function isIdentityRecordFile(fileName: string): boolean {
  return fileName.endsWith('.json');
}
