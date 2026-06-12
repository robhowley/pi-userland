import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PRESENCE_PATH_SEGMENTS } from './constants.js';

export function getDefaultPresenceDirectory(homeDirectory = homedir()): string {
  return join(homeDirectory, ...PRESENCE_PATH_SEGMENTS);
}

export function getPresenceRecordPath(
  runtimeId: string,
  directory = getDefaultPresenceDirectory(),
): string {
  return join(directory, `${runtimeId}.json`);
}

export function createPresenceTempPath(
  runtimeId: string,
  directory = getDefaultPresenceDirectory(),
  tempId = randomUUID(),
): string {
  return join(directory, `.${runtimeId}.${tempId}.tmp`);
}

export function isPresenceRecordFile(fileName: string): boolean {
  return fileName.endsWith('.json');
}
