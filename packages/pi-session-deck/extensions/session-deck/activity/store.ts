import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ACTIVITY_PATH_SEGMENTS } from './constants.js';

export function getDefaultActivityDirectory(homeDirectory = homedir()): string {
  return join(homeDirectory, ...ACTIVITY_PATH_SEGMENTS);
}

export function getActivityRecordPath(
  runtimeId: string,
  directory = getDefaultActivityDirectory(),
): string {
  return join(directory, `${runtimeId}.json`);
}

export function createActivityTempPath(
  runtimeId: string,
  directory = getDefaultActivityDirectory(),
  tempId = randomUUID(),
): string {
  return join(directory, `.${runtimeId}.${tempId}.tmp`);
}

export function isActivityRecordFile(fileName: string): boolean {
  return fileName.endsWith('.json');
}
