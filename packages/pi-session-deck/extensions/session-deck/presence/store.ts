import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PRESENCE_PATH_SEGMENTS } from './constants.js';

export const MAX_PRESENCE_RUNTIME_ID_LENGTH = 256;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function getDefaultPresenceDirectory(homeDirectory = homedir()): string {
  return join(homeDirectory, ...PRESENCE_PATH_SEGMENTS);
}

export function isSafePresenceRuntimeIdSegment(runtimeId: string): boolean {
  if (runtimeId.length === 0 || runtimeId.length > MAX_PRESENCE_RUNTIME_ID_LENGTH) {
    return false;
  }

  if (runtimeId === '.' || runtimeId === '..' || runtimeId.trim() !== runtimeId) {
    return false;
  }

  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(runtimeId);
}

export function isValidAssignedPresenceRuntimeId(runtimeId: string): boolean {
  return UUID_V4_PATTERN.test(runtimeId) && isSafePresenceRuntimeIdSegment(runtimeId);
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
